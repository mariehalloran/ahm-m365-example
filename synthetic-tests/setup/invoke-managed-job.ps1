# A single disposable, managed-identity PowerShell job. Setup operations remain in their own small scripts.

# Runs an owned operation script with Blob-backed input/output, avoiding Container Apps environment/log size limits.
function Invoke-MonitoringManagedJob($Project, $Tenant, [string]$IdentityResourceId, [string]$OperationFile, [int]$TimeoutSeconds, [hashtable]$Options = @{}) {
    $document = $Project.Document
    $subscription = $document.healthModel.subscriptionId
    $resourceGroup = $document.healthModel.resourceGroup
    $storage = $document.deployment.configurationStorageAccount
    $identity = az identity show --ids $IdentityResourceId --only-show-errors -o json | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or -not $identity.clientId) { throw 'The explicitly selected setup/job identity could not be resolved.' }
    if ($identity.tenantId -ine $Tenant.tenantId) { throw 'This one-off operation requires a tenant-local managed identity.' }
    $environment = $document.deployment.foundation.environment ?? $document.deployment.foundation.environmentResourceId
    $environmentId = Resolve-ResourceId $environment $subscription $resourceGroup 'Microsoft.App' 'managedEnvironments'
    $run = [guid]::NewGuid().ToString('N')
    $name = "m365-setup-$($run.Substring(0,12))"
    $directory = Join-Path (Split-Path $Project.File) ".monitoring-deployment/$name"
    New-Item $directory -ItemType Directory -Force | Out-Null
    if (-not $IsWindows) { chmod 700 $directory }
    $inputFile = Join-Path $directory 'input.json'
    @{
        document = $document
        tenant = $Tenant.id
        bindings = Read-Bindings $Project.EnvFile
        options = $Options
    } | ConvertTo-Json -Depth 100 | Set-Content $inputFile
    if (-not $IsWindows) { chmod 600 $inputFile }
    $files = @{
        'input.json' = $inputFile
        'job-graph.ps1' = Join-Path $PSScriptRoot 'job-graph.ps1'
        'operation.ps1' = $OperationFile
    }
    $scope = "/subscriptions/$subscription/resourceGroups/$resourceGroup/providers/Microsoft.Storage/storageAccounts/$storage/blobServices/default/containers/configuration"
    $assignments = @(az role assignment list --assignee-object-id $identity.principalId --scope $scope `
        --role 'Storage Blob Data Contributor' --subscription $subscription --only-show-errors -o json | ConvertFrom-Json)
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect the scoped setup Blob role.' }
    $createdRole = $null
    $jobCreated = $false
    $uploaded = [Collections.Generic.List[string]]::new()
    $operationError = $null
    $result = $null
    try {
        if ($assignments.Count -eq 0) {
            $createdRole = az role assignment create --assignee-object-id $identity.principalId --assignee-principal-type ServicePrincipal `
                --role 'Storage Blob Data Contributor' --scope $scope --subscription $subscription --only-show-errors --query id -o tsv
            if ($LASTEXITCODE -ne 0) { throw 'Cannot grant the one-off, container-scoped Blob role.' }
        }
        foreach ($entry in $files.GetEnumerator()) {
            $blob = "oneoff/$run/$($entry.Key)"
            az storage blob upload --account-name $storage --container-name configuration --name $blob --file $entry.Value `
                --auth-mode login --overwrite false --only-show-errors -o none
            if ($LASTEXITCODE -ne 0) { throw 'Cannot upload one-off input; deploy the configuration foundation and verify its data-plane role first.' }
            $uploaded.Add($blob)
        }
        $bootstrap = @'
$ErrorActionPreference = 'Stop'
Connect-AzAccount -Identity -AccountId $env:AZURE_CLIENT_ID -Scope Process | Out-Null
$context = New-AzStorageContext -StorageAccountName $env:SETUP_STORAGE -UseConnectedAccount
$work = Join-Path $PWD 'monitoring-oneoff'
New-Item $work -ItemType Directory -Force | Out-Null
Set-Location $work
$deadline = [DateTimeOffset]::UtcNow.AddSeconds([int]$env:SETUP_RBAC_TIMEOUT)
foreach ($file in @('input.json','job-graph.ps1','operation.ps1')) {
    do {
        try {
            Get-AzStorageBlobContent -Container configuration -Blob "$env:SETUP_PREFIX/$file" -Destination "./$file" -Context $context -Force | Out-Null
            break
        }
        catch {
            if ($_.Exception.Message -notmatch '403|AuthorizationPermissionMismatch' -or [DateTimeOffset]::UtcNow -ge $deadline) { throw }
            Start-Sleep -Seconds 5
        }
    } while ($true)
    $key = 'SETUP_HASH_' + ($file -replace '[^a-zA-Z0-9]', '_').ToUpperInvariant()
    if ((Get-FileHash "./$file" -Algorithm SHA256).Hash -ine [Environment]::GetEnvironmentVariable($key)) { throw 'One-off input/script hash mismatch.' }
}
$env:MONITORING_SETUP_INPUT = (Resolve-Path './input.json').Path
$env:MONITORING_SETUP_RESULT = Join-Path $PWD 'result.json'
$status = 0
try { & ./operation.ps1 }
catch {
    $status = 1
    if (-not (Test-Path $env:MONITORING_SETUP_RESULT)) {
        @{ bindings=@{}; failures=@(@{ category='setup-operation-failed'; message=$_.Exception.Message }); ready=0 } |
            ConvertTo-Json -Depth 20 | Set-Content $env:MONITORING_SETUP_RESULT
    }
    Write-Error -ErrorAction Continue "One-off setup failed: $($_.Exception.Message)"
}
Set-AzStorageBlobContent -Container configuration -Blob "$env:SETUP_PREFIX/result.json" -File $env:MONITORING_SETUP_RESULT -Context $context -Force | Out-Null
exit $status
'@
        $job = @{
            location = $document.deployment.location
            identity = @{ type = 'UserAssigned'; userAssignedIdentities = @{ $IdentityResourceId = @{} } }
            properties = @{
                environmentId = $environmentId
                configuration = @{
                    triggerType = 'Manual'; replicaTimeout = $TimeoutSeconds; replicaRetryLimit = 0
                    manualTriggerConfig = @{ replicaCompletionCount = 1; parallelism = 1 }
                }
                template = @{ containers = @(@{
                    name = 'setup'; image = 'mcr.microsoft.com/azure-powershell:16.5.0-azurelinux-3.0'
                    command = @('pwsh', '-NoLogo', '-NoProfile', '-Command'); args = @($bootstrap)
                    resources = @{ cpu = 2; memory = '4Gi' }
                    env = @(
                        @{ name = 'AZURE_CLIENT_ID'; value = $identity.clientId }
                        @{ name = 'SETUP_STORAGE'; value = $storage }
                        @{ name = 'SETUP_PREFIX'; value = "oneoff/$run" }
                        @{ name = 'SETUP_RBAC_TIMEOUT'; value = "$($document.deployment.rolloutTimeoutSeconds ?? 300)" }
                    ) + @($files.GetEnumerator() | ForEach-Object {
                        @{ name = 'SETUP_HASH_' + ($_.Key -replace '[^a-zA-Z0-9]', '_').ToUpperInvariant(); value = (Get-FileHash $_.Value -Algorithm SHA256).Hash }
                    })
                }) }
            }
        }
        $definition = Join-Path $directory 'job.json'
        $job | ConvertTo-Json -Depth 30 | Set-Content $definition
        if (-not $IsWindows) { chmod 600 $definition }
        az containerapp job create --name $name --resource-group $resourceGroup --subscription $subscription --yaml $definition --only-show-errors -o none
        if ($LASTEXITCODE -ne 0) { throw 'Cannot create the one-off managed-identity job.' }
        $jobCreated = $true
        az containerapp job start --name $name --resource-group $resourceGroup --subscription $subscription --only-show-errors -o none
        if ($LASTEXITCODE -ne 0) { throw 'Cannot start the one-off managed-identity job.' }
        $deadline = [DateTimeOffset]::UtcNow.AddSeconds($TimeoutSeconds + $document.deployment.rolloutTimeoutSeconds)
        do {
            Start-Sleep -Seconds 5
            $state = az containerapp job execution list --name $name --resource-group $resourceGroup --subscription $subscription `
                --only-show-errors --query '[0].properties.status' -o tsv
            if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect the tracked one-off execution.' }
            if ($state -in @('Succeeded', 'Failed', 'Stopped')) { break }
            if ([DateTimeOffset]::UtcNow -ge $deadline) { throw 'The tracked setup job exceeded its bounded execution window; inspect it before rerunning mutations.' }
        } while ($true)
        $output = Join-Path $directory 'result.json'
        az storage blob download --account-name $storage --container-name configuration --name "oneoff/$run/result.json" `
            --file $output --auth-mode login --overwrite true --only-show-errors -o none
        if ($LASTEXITCODE -ne 0) { throw "Setup did not produce its required durable result. Inspect the protected job definition in $directory." }
        $uploaded.Add("oneoff/$run/result.json")
        if (-not $IsWindows) { chmod 600 $output }
        $result = Get-Content $output -Raw | ConvertFrom-Json -Depth 100
        $result | Add-Member -NotePropertyName executionSucceeded -NotePropertyValue ($state -eq 'Succeeded')
    }
    catch { $operationError = $_.Exception }
    finally {
        $cleanup = [Collections.Generic.List[Exception]]::new()
        if ($jobCreated) {
            try {
                az containerapp job delete --name $name --resource-group $resourceGroup --subscription $subscription --yes --only-show-errors -o none
                if ($LASTEXITCODE -ne 0) { throw 'The disposable setup job could not be deleted.' }
            } catch { $cleanup.Add($_.Exception) }
        }
        foreach ($blob in $uploaded) {
            try {
                az storage blob delete --account-name $storage --container-name configuration --name $blob --auth-mode login --only-show-errors -o none
                if ($LASTEXITCODE -ne 0) { throw 'A generated one-off input/output Blob could not be deleted.' }
            } catch { $cleanup.Add($_.Exception) }
        }
        if ($createdRole) {
            try {
                az role assignment delete --ids $createdRole --subscription $subscription --only-show-errors -o none
                if ($LASTEXITCODE -ne 0) { throw 'The one-off Blob role could not be revoked; remove the recorded assignment immediately.' }
            } catch { $cleanup.Add($_.Exception) }
        }
        if ($cleanup.Count) {
            if ($operationError) { $cleanup.Add($operationError) }
            throw [AggregateException]::new("One-off cleanup failed; inspect $directory.", $cleanup)
        }
    }
    if ($operationError) { throw $operationError }
    $result
}
