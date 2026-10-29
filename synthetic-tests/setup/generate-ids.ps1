#Requires -Version 7.4
<#
.SYNOPSIS
    Looks up and writes to .env the IDs that are only known once the one-time setup in docs/setup.md is done: the
    Teams channel ID (creating the named channel if it does not exist yet), the second Teams bot's client ID, the
    Teams calling callback URL, the meeting organizer's user ID and each OneDrive account's user ID.

.DESCRIPTION
    Run after completing docs/setup.md and before `npm run deploy`:

        az login
        npm run setup:ids

    It only fills in what is missing, so running it again is safe. It never writes to monitoring.config.json.
#>
param([string]$Config = (Join-Path $PSScriptRoot '../../monitoring.config.json'))

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$project = Read-MonitoringConfig $Config
$tenant = Select-ConfiguredTenant $project.Document
$bindings = Read-Bindings $project.EnvFile
$key = { param($TargetId, $Field) Get-BindingKey $tenant.id $TargetId $Field }
$subscription = $project.Document.healthModel.subscriptionId
$resourceGroup = $project.Document.healthModel.resourceGroup

$teams = $tenant.services.teams
if ($teams.enabled -ne $false -and $teams.execution.mode -eq 'live') {
    Write-Host 'Teams'
    foreach ($target in $teams.targets | Where-Object channelName) {
        $channel = Get-GraphList "/teams/$($target.teamId)/channels?`$select=id,displayName" | Where-Object displayName -eq $target.channelName
        if (-not $channel) {
            $channel = Invoke-Graph POST "/teams/$($target.teamId)/channels" @{
                displayName = $target.channelName; description = 'Synthetic monitoring'; membershipType = 'standard'
            }
            Write-Host "  created channel '$($target.channelName)' in team $($target.teamId)"
        }
        Set-Binding $project.EnvFile $bindings (& $key $target.id 'CHANNEL_ID') $channel.id
    }

    if ($teams.access.peerIdentity) {
        $peerId = Resolve-ResourceId $teams.access.peerIdentity $subscription $resourceGroup 'Microsoft.ManagedIdentity' 'userAssignedIdentities'
        $peer = az identity show --ids $peerId --only-show-errors -o json 2>$null | ConvertFrom-Json
        if ($peer) { Set-Binding $project.EnvFile $bindings (& $key 'teams' 'BOT_PEER_CLIENT_ID') $peer.clientId }
        else { Write-Warning "Managed identity $peerId does not exist yet; see docs/setup.md." }
    }
    if ($teams.scenarios.'scheduled-meeting' -ne $false) {
        $foundation = $project.Document.deployment.foundation
        $environmentId = Resolve-ResourceId $foundation.environment $subscription $resourceGroup 'Microsoft.App' 'managedEnvironments'
        $parts = $environmentId.Split('/')
        $domain = az containerapp env show --name $parts[-1] --resource-group $parts[4] --subscription $parts[2] --query properties.defaultDomain -o tsv --only-show-errors 2>$null
        if ($domain) { Set-Binding $project.EnvFile $bindings (& $key 'teams' 'CALLING_CALLBACK_URL') "https://$($teams.worker.appName).$domain/api/calls" }
        else { Write-Warning "Container Apps environment $environmentId does not exist yet; see docs/setup.md." }
        foreach ($call in $teams.callTargets | Where-Object organizer) {
            $user = Invoke-Graph GET "/users/$($call.organizer)`?`$select=id"
            Set-Binding $project.EnvFile $bindings (& $key $call.id 'ORGANIZER_USER_ID') $user.id
        }
    }
}

$onedrive = $tenant.services.onedrive
if ($onedrive.enabled -ne $false -and $onedrive.execution.mode -eq 'live') {
    Write-Host 'OneDrive'
    $targets = $onedrive.targets.PSObject.Properties | ForEach-Object { $_.Value.users } | Sort-Object userPrincipalName -Unique
    foreach ($target in $targets) {
        $user = Invoke-Graph GET "/users/$($target.userPrincipalName)`?`$select=id"
        Set-Binding $project.EnvFile $bindings (& $key (Get-AccountTargetId $target.userPrincipalName) 'USER_ID') $user.id
    }
}

Write-Host "`nDone. Next: npm run onedrive:setup (if OneDrive is selected), npm run setup:reply-seeds (if reply-mail is selected), then npm run deploy."
