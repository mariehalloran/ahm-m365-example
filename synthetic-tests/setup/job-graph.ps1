# Graph helpers used only inside the disposable managed-identity PowerShell setup jobs.
$script:JobInput = Get-Content $env:MONITORING_SETUP_INPUT -Raw | ConvertFrom-Json -Depth 100
$script:JobTenant = $script:JobInput.document.tenants | Where-Object id -eq $script:JobInput.tenant
if (@($script:JobTenant).Count -ne 1) { throw 'The setup input must select exactly one root-configured tenant.' }
$script:GraphDeadline = [DateTimeOffset]::UtcNow.AddSeconds(1)

# Uses the selected job identity; no Azure CLI, certificate, secret or delegated credential fallback exists.
function Get-JobGraphToken {
    if (-not $script:JobToken -or $script:JobToken.ExpiresOn -le [DateTimeOffset]::UtcNow.AddMinutes(2)) {
        $script:JobToken = $script:JobAzureContext
            ? (Get-AzAccessToken -ResourceUrl 'https://graph.microsoft.com/' -DefaultProfile $script:JobAzureContext -ErrorAction Stop)
            : (Get-AzAccessToken -ResourceUrl 'https://graph.microsoft.com/' -ErrorAction Stop)
    }
    ConvertFrom-SecureString $script:JobToken.Token -AsPlainText
}

# Calls only the approved Graph v1.0 endpoint; retries safe reads, never ambiguous mailbox mutations.
function Invoke-JobGraph([string]$Method, [string]$Path, $Body = $null) {
    $url = $Path.StartsWith('/') ? "https://graph.microsoft.com/v1.0$Path" : $Path
    $uri = [uri]$url
    if ($uri.Scheme -ne 'https' -or $uri.Host -ne 'graph.microsoft.com' -or $uri.Port -ne 443 -or
        $uri.UserInfo -or $uri.Fragment -or $uri.AbsolutePath -cnotmatch '^/v1\.0/') { throw 'Unexpected setup Graph endpoint.' }
    for ($attempt = 0; $attempt -lt 3; $attempt++) {
        $remaining = [int][Math]::Ceiling(($script:GraphDeadline - [DateTimeOffset]::UtcNow).TotalSeconds)
        if ($remaining -le 0) { throw 'The configured per-target setup deadline expired.' }
        $parameters = @{
            Method = $Method; Uri = $url; TimeoutSec = [Math]::Min(30, $remaining)
            Headers = @{ Authorization = 'Bearer ' + (Get-JobGraphToken) }
            ErrorAction = 'Stop'
        }
        if ($null -ne $Body) { $parameters.Body = $Body | ConvertTo-Json -Depth 30 -Compress; $parameters.ContentType = 'application/json' }
        try { return Invoke-RestMethod @parameters }
        catch {
            $status = $_.Exception.Response.StatusCode.value__
            if ($Method -ne 'GET' -or $status -notin @(429, 502, 503, 504) -or $attempt -eq 2) { throw }
            Start-Sleep -Milliseconds (250 * [Math]::Pow(2, $attempt))
        }
    }
}

# Treats only a confirmed 404 as absent; permission and authentication failures remain visible.
function Get-OptionalJobGraph([string]$Path) {
    try { Invoke-JobGraph GET $Path }
    catch { if ($_.Exception.Response.StatusCode.value__ -eq 404) { return $null }; throw }
}

# Reads complete collections under one bounded deadline, rejecting cyclic or cross-collection pagination.
function Get-JobGraphCollection([string]$Path) {
    $first = [uri]($Path.StartsWith('/') ? "https://graph.microsoft.com/v1.0$Path" : $Path)
    $next = $first.AbsoluteUri
    $seen = [Collections.Generic.HashSet[string]]::new()
    while ($next) {
        $uri = [uri]$next
        if ($uri.Host -ne $first.Host -or $uri.Scheme -ne $first.Scheme -or $uri.AbsolutePath -ne $first.AbsolutePath -or -not $seen.Add($next)) {
            throw 'Unexpected or repeated setup Graph pagination URL.'
        }
        $page = Invoke-JobGraph GET $next
        foreach ($item in $page.value) { $item }
        $next = $page.'@odata.nextLink'
    }
}

# Uses the same account-derived key as the execution configuration.
function Get-JobAccountId([string]$Address) {
    'account-' + [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($Address.Trim().ToLowerInvariant()))).ToLowerInvariant()
}

# Generates the canonical .env key without requiring user-maintained target IDs.
function Get-JobBindingKey([string]$Target, [string]$Field) {
    "$($script:JobTenant.id.ToUpperInvariant() -replace '[^A-Z0-9]', '_')__$($Target.ToUpperInvariant() -replace '[^A-Z0-9]', '_')__$Field"
}
