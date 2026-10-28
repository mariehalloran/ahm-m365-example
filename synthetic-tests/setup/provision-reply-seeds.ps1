#Requires -Version 7.4
<#
.SYNOPSIS
    Provisions the retained self-addressed message each SELF-REPLY journey answers, one per configured Exchange
    mailbox, and writes the result (replySeed) to .env.

.DESCRIPTION
    Run after completing docs/setup.md (the Exchange worker identity must already hold Mail.ReadWrite and Mail.Send
    over the configured mailboxes) and before `npm run deploy`:

        az login
        npm run setup:reply-seeds

    Only the worker's own managed identity can create the retained message in its own mailbox, so this builds the
    worker image (if the config builds it) and runs the worker's own setup command once, in a temporary Container
    Apps job, under that identity. The job is deleted when it finishes either way. An existing valid seed is left
    alone; pass -Reprovision to replace one that no longer validates.
#>
param(
    [string]$Config = (Join-Path $PSScriptRoot '../../monitoring.config.json'),
    [switch]$Reprovision
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$project = Read-MonitoringConfig $Config
$tenant = Select-ConfiguredTenant $project.Document
$bindings = Read-Bindings $project.EnvFile
$exchange = $tenant.services.exchange
if ($exchange.enabled -eq $false -or $exchange.execution.mode -ne 'live' -or $exchange.scenarios.'reply-mail' -eq $false) {
    Write-Host 'reply-mail is not a selected live Exchange scenario; nothing to do.'
    exit 0
}

$document = $project.Document
$subscription = $document.healthModel.subscriptionId
$resourceGroup = $document.healthModel.resourceGroup
$foundation = $document.deployment.foundation
$registry = $foundation.registry.Split('/')[-1]
$environmentId = Resolve-ResourceId $foundation.environment $subscription $resourceGroup 'Microsoft.App' 'managedEnvironments'
$workerIdentity = Resolve-ResourceId $exchange.worker.identity $subscription $resourceGroup 'Microsoft.ManagedIdentity' 'userAssignedIdentities'
$identity = az identity show --ids $workerIdentity --only-show-errors -o json 2>$null | ConvertFrom-Json
if (-not $identity) { throw "Managed identity $workerIdentity does not exist yet; complete docs/setup.md first." }

$image = $document.deployment.image.reference
if ($document.deployment.image.mode -eq 'build') {
    Write-Host 'Building the worker image in ACR (about 90 seconds)'
    $repository = $document.deployment.image.repository
    az acr build --registry $registry --subscription $subscription --image "${repository}:setup" --platform linux/amd64 `
        --file Dockerfile (Join-Path $PSScriptRoot '..') -o none
    $server = az acr show --name $registry --subscription $subscription --query loginServer -o tsv
    $image = "$server/${repository}:setup"
}

# A permission failure (HTTP 403) right after a scope change is Exchange's permission cache catching up (it holds an
# app's permissions for 30 minutes to 2 hours), so the command retries, every 2 minutes for up to 2.3 hours, only
# while every failure is of that kind. The seeds go out as base64 text in a few long lines, because job logs show at
# most 300 lines.
$script = @'
umask 077
mkdir -p /tmp/.setup-seeds
cd /tmp/.setup-seeds
echo "$CONFIG_B64" | base64 -d > monitoring.config.json
echo "$ENV_B64" | base64 -d > .env
set -- --config monitoring.config.json --tenant "$TENANT" --apply --setup-only
if [ "$REPROVISION" = true ]; then set -- "$@" --reprovision-seeds; fi
status=1
for attempt in $(seq 1 70); do
  node /app/dist/exchange/src/mail-test-command.js "$@" > seed.log 2>&1
  status=$?
  cat seed.log
  [ $status -eq 0 ] && break
  grep setup-failed seed.log | grep -vq permission-failure && break
  grep -q permission-failure seed.log || break
  echo "SEED_RETRY $attempt"
  sleep 120
done
grep '__REPLY_SEED_' .env | base64 | tr -d '\n' | fold -w 4000 | sed 's/^/SEED_DATA /'
echo
echo "SEED_DONE $status"
sleep 120
'@
$encode = { param($text) [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text)) }
$job = @{
    location = $document.deployment.location
    identity = @{ type = 'UserAssigned'; userAssignedIdentities = @{ $workerIdentity = @{} } }
    properties = @{
        environmentId = $environmentId
        configuration = @{
            triggerType = 'Manual'; replicaTimeout = 9000; replicaRetryLimit = 0
            manualTriggerConfig = @{ replicaCompletionCount = 1; parallelism = 1 }
            registries = @(@{ server = $image.Split('/')[0]; identity = $workerIdentity })
        }
        template = @{ containers = @(@{
            name = 'seed'; image = $image; resources = @{ cpu = 0.25; memory = '0.5Gi' }
            command = @('/bin/sh', '-c'); args = @($script)
            env = @(
                @{ name = 'CONFIG_B64'; value = & $encode (Get-Content $project.File -Raw) }
                @{ name = 'ENV_B64'; value = & $encode ((Test-Path $project.EnvFile) ? (Get-Content $project.EnvFile -Raw) : '# none') }
                @{ name = 'TENANT'; value = $tenant.id }
                @{ name = 'REPROVISION'; value = "$Reprovision".ToLowerInvariant() }
                @{ name = 'AZURE_CLIENT_ID'; value = $identity.clientId }
                @{ name = 'AZURE_TENANT_ID'; value = $tenant.tenantId }
                @{ name = 'ENABLE_LIVE_M365'; value = 'true' }
                @{ name = 'ENABLE_BETA_SERVICE_ACTIVITY'; value = "$($document.deployment.enableBetaServiceActivity)".ToLowerInvariant() }
            )
        }) }
    }
}

$name = "m365-setup-seeds-$(Get-Date -Format 'MMddHHmmss')"
$definition = Join-Path (Split-Path $project.File) ".$name.json"
$target = @('--name', $name, '--resource-group', $resourceGroup, '--subscription', $subscription)
try {
    $job | ConvertTo-Json -Depth 10 | Set-Content $definition
    Write-Host "Starting job $name"
    az containerapp job create @target --yaml $definition --only-show-errors -o none
    az containerapp job start @target --only-show-errors -o none

    # The job prints its result and then sleeps, because job logs can only be read while its replica runs.
    $logs = ''
    $retries = 0
    for ($attempt = 1; $attempt -le 900 -and $logs -notmatch 'SEED_DONE'; $attempt++) {
        Start-Sleep -Seconds 10
        $status = try { az containerapp job execution list @target --query '[0].properties.status' -o tsv --only-show-errors 2>$null } catch { '' }
        $logs = try { (az containerapp job logs show @target --container seed --format text --tail 300 --only-show-errors 2>$null) -join "`n" } catch { '' }
        if ($status -eq 'Failed') { throw "The seed job failed to run: $logs" }
        $latest = [regex]::Matches($logs, 'SEED_RETRY (\d+)') | ForEach-Object { [int]$_.Groups[1].Value } | Measure-Object -Maximum
        if ($latest.Maximum -gt $retries) {
            $retries = $latest.Maximum
            Write-Host "  Exchange has not applied the mailbox permissions yet (it caches them for 30 minutes to 2 hours); retry $retries"
        }
    }
    $done = [regex]::Match($logs, 'SEED_DONE (\d+)')
    $tail = ($logs -split "`n" | Select-Object -Last 25) -join "`n"
    if (-not $done.Success) { throw "The seed job did not finish in 2.5 hours. Last output:`n$tail" }
    $data = ([regex]::Matches($logs, 'SEED_DATA ([A-Za-z0-9+/=]+)') | ForEach-Object { $_.Groups[1].Value }) -join ''
    foreach ($line in [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($data)) -split "`n") {
        if ($line -match '^([A-Z0-9_]+__REPLY_SEED_[A-Z_]+)=(\S+)$') { Set-Binding $project.EnvFile $bindings $Matches[1] $Matches[2] }
    }
    if ($done.Groups[1].Value -ne '0') { throw "Provisioning reply seeds failed (exit $($done.Groups[1].Value)). Last output:`n$tail" }
    Write-Host "`nDone. Next: npm run deploy"
}
finally {
    az containerapp job delete @target --yes --only-show-errors 2>$null | Out-Null
    Remove-Item $definition -ErrorAction SilentlyContinue
}
