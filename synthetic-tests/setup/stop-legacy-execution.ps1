#Requires -Version 7.4
<#
.SYNOPSIS
Inventories obsolete owned Graph workers and the ingestion Function; -Apply stops them without deleting resources or data.
#>
param(
    [string]$Config = (Join-Path $PSScriptRoot '../../monitoring.config.json'),
    [switch]$Apply
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
. (Join-Path $PSScriptRoot 'common.ps1')
$project = Read-MonitoringConfig $Config
$document = $project.Document
$resources = @(az resource list --resource-group $document.healthModel.resourceGroup --subscription $document.healthModel.subscriptionId --only-show-errors -o json | ConvertFrom-Json |
    Where-Object { $_.tags.workload -eq $document.healthModel.name -and (
        ($_.type -eq 'Microsoft.App/containerApps' -and $_.tags.purpose -eq 'synthetic-worker') -or
        ($_.type -eq 'Microsoft.Web/sites' -and $_.tags.purpose -eq 'synthetic-observations') -or
        ($_.type -eq 'Microsoft.EventHub/namespaces' -and $_.tags.purpose -eq 'synthetic-observations')) })
$directory = Join-Path (Split-Path $project.File) '.monitoring-deployment'
New-Item $directory -ItemType Directory -Force | Out-Null
$file = Join-Path $directory 'legacy-execution-review.json'
$resources | ConvertTo-Json -Depth 20 | Set-Content $file
if (-not $IsWindows) { chmod 600 $file }
Write-Host "Found $($resources.Count) legacy resources. Review $file before applying."
if (-not $Apply) { return }
foreach ($resource in $resources) {
    if ($resource.type -eq 'Microsoft.App/containerApps') {
        az resource invoke-action --ids $resource.id --action stop --api-version 2024-10-02-preview --only-show-errors -o none
    }
    elseif ($resource.type -eq 'Microsoft.Web/sites') {
        az functionapp stop --ids $resource.id --only-show-errors -o none
    }
}
if (-not $document.logAnalytics.enabled) {
    $alerts = @(az monitor scheduled-query list --resource-group $document.healthModel.resourceGroup --subscription $document.healthModel.subscriptionId --only-show-errors -o json | ConvertFrom-Json |
        Where-Object name -eq "$($document.healthModel.name)-observation-freshness")
    foreach ($alert in $alerts) {
        az monitor scheduled-query update --ids $alert.id --enabled false --only-show-errors -o none
    }
}
Write-Host 'Legacy execution is stopped. Event Hubs, Capture archives, storage, identities, roles and historical observations were preserved; review ongoing costs and retirement separately.'
