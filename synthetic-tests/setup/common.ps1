# Shared helpers for the setup scripts in this folder: reading the config, and reading/writing .env.
# Not meant to be run directly; the setup scripts dot-source it.

function Read-MonitoringConfig([string]$Path) {
    $resolved = (Resolve-Path $Path).Path
    $document = Get-Content $resolved -Raw | ConvertFrom-Json -Depth 100
    if ($document.PSObject.Properties.Name -contains 'serviceFiles') {
        $serviceNames = @('exchange', 'teams', 'onedrive', 'sharepoint')
        $serviceFiles = $document.serviceFiles
        $tenantIds = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
        foreach ($tenant in @($document.tenants)) {
            if (-not $tenant.id) { throw "Main config tenant entries require id values when serviceFiles is set." }
            if ($tenantIds.Contains($tenant.id)) { throw "Main config tenant ids must be unique when serviceFiles is set." }
            $null = $tenantIds.Add($tenant.id)
            if ($tenant.PSObject.Properties.Name -contains 'services') {
                throw "Remove tenants[].services from monitoring.config.json when serviceFiles is configured."
            }
        }
        $serviceConfigs = @{}
        foreach ($service in $serviceNames) {
            $relativePath = $serviceFiles.$service
            if ([string]::IsNullOrWhiteSpace($relativePath)) {
                throw "serviceFiles.$service is required."
            }
            $candidate = [System.IO.Path]::IsPathRooted($relativePath) ? $relativePath : (Join-Path (Split-Path $resolved) $relativePath)
            try { $servicePath = (Resolve-Path $candidate).Path }
            catch { throw "Cannot resolve service file path '$relativePath' for $service." }
            $serviceDocument = Get-Content $servicePath -Raw | ConvertFrom-Json -Depth 100
            if ($serviceDocument.schemaVersion -ne '2.0' -or $serviceDocument.service -ne $service) {
                throw "Service file '$relativePath' must declare schemaVersion 2.0 and service '$service'."
            }
            $entries = @{}
            foreach ($entry in @($serviceDocument.tenants)) {
                if (-not $entry.id) { throw "Service file '$relativePath' tenant entries require id values." }
                if ($entries.ContainsKey($entry.id)) { throw "Service file '$relativePath' has duplicate tenant id '$($entry.id)'." }
                if (-not $tenantIds.Contains($entry.id)) { throw "Service file '$relativePath' includes unknown tenant id '$($entry.id)'." }
                $entries[$entry.id] = $entry.config
            }
            $serviceConfigs[$service] = $entries
        }
        foreach ($tenant in @($document.tenants)) {
            $services = [ordered]@{}
            foreach ($service in $serviceNames) {
                if (-not $serviceConfigs[$service].ContainsKey($tenant.id)) {
                    throw "Tenant '$($tenant.id)' is missing in service file '$($serviceFiles.$service)'."
                }
                $services[$service] = $serviceConfigs[$service][$tenant.id]
            }
            $tenant | Add-Member -NotePropertyName services -NotePropertyValue ([pscustomobject]$services) -Force
        }
        $document.PSObject.Properties.Remove('serviceFiles')
    }
    [pscustomobject]@{
        File = $resolved
        EnvFile = Join-Path (Split-Path $resolved) '.env'
        Document = $document
    }
}

$script:GraphTenantId = $null
$script:GraphToken = $null

# The signed-in administrator decides which configured tenant a script acts on.
function Select-ConfiguredTenant($Document) {
    $script:GraphTenantId = $null
    $script:GraphToken = $null
    $PSNativeCommandUseErrorActionPreference = $false
    try { $response = az account show --only-show-errors -o json 2>$null }
    catch { throw 'Unable to read the Azure CLI account. Run: az login --tenant <tenantId>' }
    if ($LASTEXITCODE -ne 0 -or -not $response) {
        throw 'Unable to read the Azure CLI account. Run: az login --tenant <tenantId>'
    }
    try { $account = $response | ConvertFrom-Json -ErrorAction Stop }
    catch { throw 'Azure CLI returned invalid account JSON.' }
    if ($account -isnot [pscustomobject] -or $account.tenantId -isnot [string] -or [string]::IsNullOrWhiteSpace($account.tenantId)) {
        throw 'Azure CLI did not return a valid account tenant.'
    }
    $tenants = @($Document.tenants | Where-Object { $_.tenantId -eq $account.tenantId })
    if ($tenants.Count -ne 1) {
        throw 'The signed-in Azure CLI tenant must match exactly one configured tenant. Run: az login --tenant <tenantId>'
    }
    $tenant = $tenants[0]
    $script:GraphTenantId = $tenant.tenantId
    Write-Host "Tenant '$($tenant.id)', signed in as $($account.user.name)"
    $tenant
}

function Get-AccountTargetId([string]$Address) {
    $bytes = [Text.Encoding]::UTF8.GetBytes($Address.Trim().ToLowerInvariant())
    'account-' + [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($bytes)).ToLowerInvariant()
}

function Get-BindingKey([string]$TenantId, [string]$TargetId, [string]$Field) {
    $part = { param($text) $text.ToUpperInvariant() -replace '[^A-Z0-9]', '_' }
    "$(& $part $TenantId)__$(& $part $TargetId)__$Field"
}

function Read-Bindings([string]$EnvFile) {
    $values = @{}
    if (Test-Path $EnvFile) {
        foreach ($line in Get-Content $EnvFile) {
            if ($line -match '^([A-Z0-9_]+)=(.*)$') { $values[$Matches[1]] = $Matches[2] }
        }
    }
    $values
}

# Merges an entire scalable setup result in one atomic write, preserving unrelated generated IDs and comments.
function Merge-Bindings([string]$EnvFile, [hashtable]$Bindings, [hashtable]$Updates) {
    $lines = (Test-Path $EnvFile) ? @(Get-Content $EnvFile) : @('# Generated by PowerShell setup scripts. Not for secrets.')
    $remaining = @{} + $Updates
    $output = [Collections.Generic.List[string]]::new()
    foreach ($line in $lines) {
        if ($line -match '^([A-Z0-9_]+)=') {
            $name = $Matches[1]
            if ($remaining.ContainsKey($name)) {
                $output.Add("$name=$($remaining[$name])")
                $remaining.Remove($name)
                continue
            }
        }
        $output.Add($line)
    }
    foreach ($name in @($remaining.Keys | Sort-Object)) { $output.Add("$name=$($remaining[$name])") }
    $temporary = "$EnvFile.generated"
    $output | Set-Content $temporary
    if (-not $IsWindows) { chmod 600 $temporary }
    Move-Item $temporary $EnvFile -Force
    foreach ($name in $Updates.Keys) { $Bindings[$name] = $Updates[$name] }
    Write-Host "Saved $($Updates.Count) generated bindings."
}

# Merges one KEY=value into .env, replacing it in place if present; every other line is kept.
function Set-Binding([string]$EnvFile, [hashtable]$Bindings, [string]$Key, [string]$Value) {
    if ($Bindings[$Key] -eq $Value) { return }
    $lines = (Test-Path $EnvFile) ? @(Get-Content $EnvFile) : @('# Generated by the setup scripts; safe to delete and regenerate. Not for secrets.')
    $temporary = "$EnvFile.tmp"
    (@($lines | Where-Object { -not $_.StartsWith("$Key=") }) + "$Key=$Value") | Set-Content $temporary
    if (-not $IsWindows) { chmod 600 $temporary }
    Move-Item $temporary $EnvFile -Force
    $Bindings[$Key] = $Value
    Write-Host "  wrote $Key"
}

# A bare name is a resource in the health model's resource group; a value that starts with / is a full resource ID.
function Resolve-ResourceId([string]$Value, [string]$SubscriptionId, [string]$ResourceGroup, [string]$Provider, [string]$Type) {
    if ($Value.StartsWith('/')) { return $Value }
    "/subscriptions/$SubscriptionId/resourceGroups/$ResourceGroup/providers/$Provider/$Type/$Value"
}

# Select-ConfiguredTenant must succeed before using either Graph helper.
function Invoke-Graph([string]$Method, [string]$Path, $Body) {
    $url = $Path
    if ($Path.StartsWith('/') -and -not $Path.StartsWith('//')) { $url = "https://graph.microsoft.com/v1.0$Path" }
    $uri = $null
    if ($Path -match '[\s\\]' -or
        $url -notmatch '\Ahttps://graph\.microsoft\.com(?::443)?/v1\.0(?:/|\?|$)' -or
        -not [uri]::TryCreate($url, [UriKind]::Absolute, [ref]$uri) -or
        -not $uri.IsWellFormedOriginalString() -or
        $uri.Host -ine 'graph.microsoft.com' -or $uri.Port -ne 443 -or $uri.UserInfo -or $uri.Fragment -or
        $uri.AbsolutePath -cnotmatch '^/v1\.0(?:/|$)') {
        throw 'Graph requests require a relative /path or an HTTPS graph.microsoft.com/v1.0 URL without userinfo or a fragment.'
    }
    if (-not $script:GraphTenantId) { throw 'Call Select-ConfiguredTenant before using the Graph helpers.' }

    if (-not $script:GraphToken -or $script:GraphToken.TenantId -ine $script:GraphTenantId -or
        $script:GraphToken.ExpiresOn -le [DateTimeOffset]::UtcNow.AddMinutes(2)) {
        $script:GraphToken = $null
        $PSNativeCommandUseErrorActionPreference = $false
        try {
            $response = az account get-access-token --resource-type ms-graph --tenant $script:GraphTenantId --only-show-errors -o json 2>$null
        }
        catch { throw 'Unable to obtain a Microsoft Graph token from Azure CLI. Run: az login --tenant <tenantId>' }
        if ($LASTEXITCODE -ne 0 -or -not $response) {
            throw 'Unable to obtain a Microsoft Graph token from Azure CLI. Run: az login --tenant <tenantId>'
        }
        try { $token = $response | ConvertFrom-Json -ErrorAction Stop }
        catch { throw 'Azure CLI returned invalid Microsoft Graph token JSON.' }
        if ($token -isnot [pscustomobject] -or $token.accessToken -isnot [string] -or
            [string]::IsNullOrWhiteSpace($token.accessToken) -or $token.accessToken -match '\s' -or $token.tokenType -ine 'Bearer') {
            throw 'Azure CLI returned an invalid Microsoft Graph token response.'
        }
        if ($token.tenant -isnot [string] -or $token.tenant -ine $script:GraphTenantId) {
            throw 'Azure CLI returned a Microsoft Graph token for a different tenant than Select-ConfiguredTenant selected.'
        }
        $expiresOn = 0L
        if (-not [long]::TryParse([string]$token.expires_on, [ref]$expiresOn)) {
            throw 'A valid UTC token expiry (expires_on) is required. Use Azure CLI 2.54.0 or later.'
        }
        try { $expiresAt = [DateTimeOffset]::FromUnixTimeSeconds($expiresOn) }
        catch { throw 'Azure CLI returned an invalid UTC token expiry (expires_on).' }
        if ($expiresAt -le [DateTimeOffset]::UtcNow.AddMinutes(2)) {
            throw 'Azure CLI returned an expired or near-expiry Microsoft Graph token. Run: az login --tenant <tenantId>'
        }
        $script:GraphToken = @{ AccessToken = $token.accessToken; ExpiresOn = $expiresAt; TenantId = $token.tenant }
    }
    $request = @{
        Method = $Method; ContentType = 'application/json'; Uri = $url
        Headers = @{ Authorization = 'Bearer ' + $script:GraphToken.AccessToken }
        MaximumRedirection = 0; ErrorAction = 'Stop'
    }
    if ($Body) { $request.Body = $Body | ConvertTo-Json -Depth 5 }
    try { Invoke-RestMethod @request }
    catch {
        $detail = ($_.ErrorDetails.Message ?? $_.Exception.Message).Replace($script:GraphToken.AccessToken, '[redacted]')
        throw "$Method $Path failed: $detail"
    }
}

function Get-GraphList([string]$Path) {
    while ($Path) {
        $page = Invoke-Graph GET $Path
        $page.value
        $Path = $page.'@odata.nextLink'
    }
}
