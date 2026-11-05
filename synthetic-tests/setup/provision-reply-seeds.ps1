#Requires -Version 7.4
<#
.SYNOPSIS
Ensures every selected Exchange mailbox has its own retained, self-addressed SELF-REPLY fixture.
.DESCRIPTION
Runs readable PowerShell in one disposable job under the selected Exchange identity.
No recipient account, Node setup command, uploaded certificate, or automatic retry of an ambiguous send is used.
#>
param(
    [string]$Config = (Join-Path $PSScriptRoot '../../monitoring.config.json'),
    [switch]$Reprovision
)
$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
. (Join-Path $PSScriptRoot 'common.ps1')
. (Join-Path $PSScriptRoot 'invoke-managed-job.ps1')
$project = Read-MonitoringConfig $Config
$tenant = Select-ConfiguredTenant $project.Document
$selected = $tenant.services.exchange
if ($selected.enabled -eq $false -or $selected.execution.mode -ne 'live' -or $selected.scenarios.'reply-mail' -eq $false) {
    Write-Host 'No live SELF-REPLY journey is selected; nothing to provision.'
    return
}
$document = $project.Document
$targets = @($selected.targets.PSObject.Properties | ForEach-Object { $_.Value.users })
$identityId = Resolve-ResourceId ($selected.identity ?? $selected.identityResourceId) $document.healthModel.subscriptionId `
    $document.healthModel.resourceGroup 'Microsoft.ManagedIdentity' 'userAssignedIdentities'
$timeout = [int]([Math]::Ceiling($targets.Count / $selected.execution.maxConcurrentRequests) *
    ($selected.execution.timeoutSeconds + $selected.execution.cleanupGraceSeconds) + $document.deployment.rolloutTimeoutSeconds)
$result = Invoke-MonitoringManagedJob $project $tenant $identityId (Join-Path $PSScriptRoot 'reply-seeds-job.ps1') $timeout @{
    reprovision = [bool]$Reprovision
}
$updates = @{}
foreach ($entry in $result.bindings.PSObject.Properties) { $updates[$entry.Name] = [string]$entry.Value }
Merge-Bindings $project.EnvFile (Read-Bindings $project.EnvFile) $updates
if (-not $result.executionSucceeded -or @($result.failures).Count) {
    throw 'One or more fixture attempts failed. Successful retained fixtures were saved; inspect protected per-target setup timing/errors before retrying.'
}
Write-Host "Ready: $($result.ready) single-mailbox SELF-REPLY fixtures."
