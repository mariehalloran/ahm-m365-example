#Requires -Version 7.4
<#
.SYNOPSIS
Provisions selected OneDrive folders and grants only those folders to the execution identity.
.DESCRIPTION
-Apply -GrantTemporaryPermission explicitly approves Files.ReadWrite.All for the dedicated setup identity for one tracked job.
The permission is revoked immediately afterwards, including when setup fails. No certificate or user-token worker credential is used.
#>
param(
    [string]$Config = (Join-Path $PSScriptRoot '../../monitoring.config.json'),
    [switch]$Apply,
    [switch]$GrantTemporaryPermission
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'invoke-managed-job.ps1')
$project = Read-MonitoringConfig $Config
$tenant = Select-ConfiguredTenant $project.Document
$selected = $tenant.services.onedrive
$targets = @($selected.targets.PSObject.Properties | ForEach-Object { $_.Value.users })
if ($selected.enabled -eq $false) { throw 'OneDrive is disabled in the root configuration.' }
if (-not $Apply) { Write-Host "Plan: inspect/provision $($targets.Count) selected folders and scoped grants. No permission or resource changes."; return }
if (-not $GrantTemporaryPermission) { throw 'Review the runbook, then explicitly pass -GrantTemporaryPermission to approve the dedicated one-off Files.ReadWrite.All grant.' }
$settings = $selected.setup
if (-not $settings) { throw 'Select the dedicated OneDrive setup identity and its concurrency/deadline in the root configuration.' }
$document = $project.Document
$subscription = $document.healthModel.subscriptionId
$group = $document.healthModel.resourceGroup
$identityId = Resolve-ResourceId ($settings.identity ?? $settings.identityResourceId) $subscription $group 'Microsoft.ManagedIdentity' 'userAssignedIdentities'
$workerId = Resolve-ResourceId ($selected.identity ?? $selected.identityResourceId) $subscription $group 'Microsoft.ManagedIdentity' 'userAssignedIdentities'
if ($identityId -ieq $workerId) { throw 'The privileged setup identity must be separate from the OneDrive execution identity.' }
$existing = @(az identity list --resource-group $group --subscription $subscription --only-show-errors -o json | ConvertFrom-Json | Where-Object id -ieq $identityId)
if ($existing.Count -eq 0) {
    if ($settings.identityResourceId -or ($settings.identity -and $settings.identity.StartsWith('/'))) { throw 'The explicitly referenced setup identity does not exist.' }
    $setupIdentity = az identity create --name $settings.identity --resource-group $group --subscription $subscription `
        --location $document.deployment.location --only-show-errors -o json | ConvertFrom-Json
}
else { $setupIdentity = $existing[0] }
$worker = az identity show --ids $workerId --only-show-errors -o json | ConvertFrom-Json
$graph = @(Get-GraphList "/servicePrincipals?`$filter=appId eq '00000003-0000-0000-c000-000000000000'")[0]
$role = @($graph.appRoles | Where-Object { $_.value -eq 'Files.ReadWrite.All' -and $_.allowedMemberTypes -contains 'Application' })
if ($role.Count -ne 1) { throw 'The Microsoft Graph Files.ReadWrite.All application role could not be resolved.' }
$prior = @(Get-GraphList "/servicePrincipals/$($setupIdentity.principalId)/appRoleAssignments" |
    Where-Object { $_.resourceId -eq $graph.id -and $_.appRoleId -eq $role[0].id })
if ($prior.Count) { throw 'The dedicated setup identity already has the broad grant. Review and remove the previous grant before running this bounded one-off operation.' }
$grant = $null
$failure = $null
try {
    $grant = Invoke-Graph POST "/servicePrincipals/$($setupIdentity.principalId)/appRoleAssignments" @{
        principalId = $setupIdentity.principalId; resourceId = $graph.id; appRoleId = $role[0].id
    }
    $timeout = [int]([Math]::Ceiling($targets.Count / $settings.concurrency) * $settings.targetTimeoutSeconds + $document.deployment.rolloutTimeoutSeconds)
    $result = Invoke-MonitoringManagedJob $project $tenant $identityId (Join-Path $PSScriptRoot 'onedrive-job.ps1') $timeout @{
        workerClientId = $worker.clientId
    }
    $updates = @{}
    foreach ($entry in $result.bindings.PSObject.Properties) { $updates[$entry.Name] = [string]$entry.Value }
    Merge-Bindings $project.EnvFile (Read-Bindings $project.EnvFile) $updates
    if (-not $result.executionSucceeded -or @($result.failures).Count) { throw "OneDrive setup has $(@($result.failures).Count) failures; inspect the protected one-off result. Successful bindings were retained." }
    Write-Host "Ready: $($result.ready) OneDrive targets."
}
catch { $failure = $_.Exception }
finally {
    if ($grant) {
        try { Invoke-Graph DELETE "/servicePrincipals/$($setupIdentity.principalId)/appRoleAssignments/$($grant.id)" | Out-Null }
        catch {
            $errors = @($_.Exception)
            if ($failure) { $errors += $failure }
            throw [AggregateException]::new('The one-off Graph grant was not revoked. Remove it immediately before any further setup.', $errors)
        }
    }
}
if ($failure) { throw $failure }
