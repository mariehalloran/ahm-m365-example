#Requires -Version 7.4
<#
.SYNOPSIS
Creates the dedicated secretless Function API registration and dispatcher identity, or verifies explicitly bound existing resources.
#>
param([string]$Config = (Join-Path $PSScriptRoot '../../monitoring.config.json'))

$ErrorActionPreference = 'Stop'
$PSNativeCommandUseErrorActionPreference = $true
. (Join-Path $PSScriptRoot 'common.ps1')
$project = Read-MonitoringConfig $Config
$document = $project.Document
$settings = $document.deployment
$account = az account show --only-show-errors -o json | ConvertFrom-Json
if ($account.id -ine $document.healthModel.subscriptionId -or $account.tenantId -ine ($settings.azureTenantId ?? $document.tenants[0].tenantId)) {
    throw 'Sign in to the root-configured Azure subscription and tenant before configuring Function authentication.'
}
$bindings = Read-Bindings $project.EnvFile
$apiClientId = $settings.functions.apiClientId ?? $bindings.FUNCTION_API_CLIENT_ID
if (-not $apiClientId) {
    $displayName = "$($document.healthModel.name) durable lane API"
    $matches = @(az ad app list --display-name $displayName --only-show-errors -o json | ConvertFrom-Json | Where-Object displayName -eq $displayName)
    if ($matches.Count -gt 1) { throw 'Several API registrations have the expected name; bind the approved apiClientId explicitly in the root config.' }
    if ($matches.Count -eq 1) { $application = $matches[0] }
    else {
        $application = az ad app create --display-name $displayName --sign-in-audience AzureADMyOrg --only-show-errors -o json | ConvertFrom-Json
        $body = @{ api = @{ requestedAccessTokenVersion = 2 } } | ConvertTo-Json -Compress
        az rest --method PATCH --url "https://graph.microsoft.com/v1.0/applications/$($application.id)" --body $body --only-show-errors -o none
    }
    $apiClientId = $application.appId
}
$application = az ad app show --id $apiClientId --only-show-errors -o json | ConvertFrom-Json
if ($application.signInAudience -ne 'AzureADMyOrg' -or $application.api.requestedAccessTokenVersion -ne 2) {
    throw 'The explicitly selected API app must be single-tenant and request v2 access tokens. Review existing applications manually; this script never changes their Graph grants.'
}
$principals = @(az ad sp list --filter "appId eq '$apiClientId'" --only-show-errors -o json | ConvertFrom-Json)
if ($principals.Count -gt 1) { throw 'The selected API application has ambiguous enterprise application bindings.' }
$principal = $principals.Count -eq 1 ? $principals[0] : (az ad sp create --id $apiClientId --only-show-errors -o json | ConvertFrom-Json)
if ($principal.appRoleAssignmentRequired) {
    throw 'The API enterprise app requires assignment. Review it manually: this design uses roleless application tokens and a Function-local, single-managed-identity caller ACL.'
}

$coordinator = $settings.coordinator
if ($coordinator.identity -or $coordinator.identityResourceId) {
    $identityId = Resolve-ResourceId ($coordinator.identity ?? $coordinator.identityResourceId) $document.healthModel.subscriptionId $document.healthModel.resourceGroup 'Microsoft.ManagedIdentity' 'userAssignedIdentities'
    $identity = az identity show --ids $identityId --only-show-errors -o json | ConvertFrom-Json
}
else {
    if (-not $coordinator.identityName) { throw 'The root dispatcher needs identity or identityName.' }
    $existing = @(az identity list --resource-group $document.healthModel.resourceGroup --subscription $document.healthModel.subscriptionId --only-show-errors -o json | ConvertFrom-Json |
        Where-Object name -eq $coordinator.identityName)
    $identity = $existing.Count -eq 1 ? $existing[0] : (az identity create --name $coordinator.identityName `
        --resource-group $document.healthModel.resourceGroup --subscription $document.healthModel.subscriptionId `
        --location $settings.location --only-show-errors -o json | ConvertFrom-Json)
}
if ($identity.tenantId -ine $account.tenantId) { throw 'The dispatcher identity must belong to the configured Azure tenant.' }
Set-Binding $project.EnvFile $bindings 'FUNCTION_API_CLIENT_ID' $apiClientId
Set-Binding $project.EnvFile $bindings 'COORDINATOR_CLIENT_ID' $identity.clientId
Write-Host 'Function API and dispatcher bindings are ready. No secrets, certificates, Graph grants or function keys were created.'
