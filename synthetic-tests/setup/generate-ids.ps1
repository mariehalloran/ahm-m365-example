#Requires -Version 7.4
<#
.SYNOPSIS
    Looks up and writes to .env the IDs that are only known once the one-time setup in docs/setup.md is done: the
    Teams channel ID (creating the named channel if it does not exist yet), both client IDs of each Teams bot pair, the
    Teams calling callback URL, the meeting organizer's user ID, each OneDrive account's user ID and existing
    SharePoint site/library/folder/list IDs. SharePoint discovery uses the selected managed identity, never Azure CLI sign-in.

.DESCRIPTION
    Run after completing docs/setup.md and before `npm run deploy`:

        az login
        npm run setup:ids

    It only fills in what is missing, so running it again is safe. It never writes to monitoring.config.json.
#>
param(
    [string]$Config = (Join-Path $PSScriptRoot '../../monitoring.config.json'),
    [switch]$SharePointOnly,
    [string]$Tenant,
    [switch]$UpdateBotEndpoints
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

# Runs read-only SharePoint discovery without the other services' administrator Azure CLI session.
function Resolve-SharePointIds([string]$File, [string]$TenantAlias) {
    if ($TenantAlias) { & (Join-Path $PSScriptRoot 'discover-sharepoint.ps1') -Config $File -Tenant $TenantAlias }
    else { & (Join-Path $PSScriptRoot 'discover-sharepoint.ps1') -Config $File }
}

if ($SharePointOnly) {
    Resolve-SharePointIds (Resolve-Path $Config).Path $Tenant
    return
}
if ($Tenant) { throw '-Tenant is supported only with -SharePointOnly; other setup IDs use the administrator Azure CLI tenant.' }

$project = Read-MonitoringConfig $Config
$tenant = Select-ConfiguredTenant $project.Document
$bindings = Read-Bindings $project.EnvFile
$key = { param($TargetId, $Field) Get-BindingKey $tenant.id $TargetId $Field }
$subscription = $project.Document.healthModel.subscriptionId
$resourceGroup = $project.Document.healthModel.resourceGroup

$updates = @{}
foreach ($serviceName in @('exchange','teams','onedrive','sharepoint')) {
    $selection = $tenant.services.$serviceName
    if ($selection.enabled -eq $false) { continue }
    $identityId = Resolve-ResourceId ($selection.identity ?? $selection.identityResourceId) $subscription $resourceGroup 'Microsoft.ManagedIdentity' 'userAssignedIdentities'
    $identity = az identity show --ids $identityId --only-show-errors -o json | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or -not $identity.clientId) { throw 'A selected execution identity could not be resolved.' }
    $updates[(& $key $serviceName 'IDENTITY_CLIENT_ID')] = $identity.clientId
}
Merge-Bindings $project.EnvFile $bindings $updates

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

    foreach ($pair in $teams.botPairs) {
        foreach ($identity in @(
            @{ Resource = $pair.identity ?? $pair.identityResourceId; Field = 'BOT_CLIENT_ID' },
            @{ Resource = $pair.peerIdentity ?? $pair.botPeerManagedIdentityResourceId; Field = 'BOT_PEER_CLIENT_ID' }
        )) {
            if (-not $identity.Resource) { throw "Bot pair $($pair.id) requires both identity and peerIdentity; see docs/setup.md." }
            $identityId = Resolve-ResourceId $identity.Resource $subscription $resourceGroup 'Microsoft.ManagedIdentity' 'userAssignedIdentities'
            $resolved = az identity show --ids $identityId --only-show-errors -o json | ConvertFrom-Json
            if ($LASTEXITCODE -ne 0 -or -not $resolved.clientId) { throw "Unable to resolve managed identity $identityId; see docs/setup.md." }
            Set-Binding $project.EnvFile $bindings (& $key $pair.id $identity.Field) $resolved.clientId
        }
    }
    if ($teams.scenarios.'scheduled-meeting' -ne $false) {
        $baseName = $project.Document.deployment.functions.appName
        $functionName = "$($baseName.Substring(0, [Math]::Min(57, $baseName.Length)))-tm"
        $functions = @(az functionapp list --resource-group $resourceGroup --subscription $subscription --only-show-errors -o json |
            ConvertFrom-Json | Where-Object name -eq $functionName)
        if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect the deployed Function callback endpoint.' }
        if ($functions.Count -eq 1 -and $functions[0].defaultHostName) {
            $callback = "https://$($functions[0].defaultHostName)/api/calls"
            Set-Binding $project.EnvFile $bindings (& $key 'teams' 'CALLING_CALLBACK_URL') $callback
            if ($UpdateBotEndpoints) {
                foreach ($bot in $teams.botPairs | ForEach-Object { @($_.bot ?? $_.botResourceId, $_.peerBot ?? $_.botPeerResourceId) }) {
                    $botId = Resolve-ResourceId $bot $subscription $resourceGroup 'Microsoft.BotService' 'botServices'
                    $parts = $botId.Split('/')
                    az bot update --name $parts[-1] --resource-group $parts[4] --subscription $parts[2] --endpoint $callback --only-show-errors -o none
                    if ($LASTEXITCODE -ne 0) { throw 'A selected bot registration endpoint could not be updated.' }
                }
            }
        }
        else { Write-Warning 'Deploy the foundation first, then rerun setup:ids to bind the actual Flex Function hostname.' }
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

if ($tenant.services.sharepoint.enabled -eq $true -and $tenant.services.sharepoint.execution.mode -eq 'live') {
    Resolve-SharePointIds $project.File $tenant.id
}

Write-Host "`nDone. Next: npm run onedrive:setup (if OneDrive is selected), npm run setup:reply-seeds (if reply-mail is selected), then npm run deploy."
