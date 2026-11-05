#Requires -Version 7.4
<#
.SYNOPSIS
Reads only approved SharePoint sites using the selected execution managed identity and writes generated IDs to .env.
#>
param(
    [string]$Config = (Join-Path $PSScriptRoot '../../monitoring.config.json'),
    [string]$Tenant
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'invoke-managed-job.ps1')
$project = Read-MonitoringConfig $Config
$tenantRecord = $Tenant ? @($project.Document.tenants | Where-Object id -eq $Tenant) : @(Select-ConfiguredTenant $project.Document)
if ($tenantRecord.Count -ne 1) { throw 'Select exactly one configured tenant.' }
$selected = $tenantRecord[0].services.sharepoint
if ($selected.enabled -eq $false) { Write-Host 'SharePoint is disabled; nothing to discover.'; return }
$id = Resolve-ResourceId ($selected.identity ?? $selected.identityResourceId) $project.Document.healthModel.subscriptionId `
    $project.Document.healthModel.resourceGroup 'Microsoft.ManagedIdentity' 'userAssignedIdentities'
$timeout = [int]($selected.targets.Count * $selected.execution.timeoutSeconds + $project.Document.deployment.rolloutTimeoutSeconds)
$result = Invoke-MonitoringManagedJob $project $tenantRecord[0] $id (Join-Path $PSScriptRoot 'sharepoint-job.ps1') $timeout
$updates = @{}
foreach ($entry in $result.bindings.PSObject.Properties) { $updates[$entry.Name] = [string]$entry.Value }
Merge-Bindings $project.EnvFile (Read-Bindings $project.EnvFile) $updates
if (-not $result.executionSucceeded -or @($result.failures).Count) { throw 'SharePoint discovery failed for one or more targets; successful bindings were preserved in .env.' }
Write-Host "Resolved $($result.ready) approved SharePoint targets without creating sites, folders, lists or permissions."
