. (Join-Path $PSScriptRoot 'job-graph.ps1')
$selected = $script:JobTenant.services.sharepoint
$bindings = @{}
$outcomes = @()
foreach ($target in $selected.targets) {
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $script:GraphDeadline = [DateTimeOffset]::UtcNow.AddSeconds($selected.execution.timeoutSeconds)
    try {
        $url = [uri]$target.siteUrl
        if ($url.Scheme -ne 'https' -or $url.Host -notmatch '^[a-z0-9][a-z0-9-]*\.sharepoint\.com$' -or
            $url.Host.EndsWith('-my.sharepoint.com') -or $url.AbsolutePath -notmatch '^/(sites|teams)/[^/]+') { throw 'Only the approved non-personal SharePoint site URL is accepted.' }
        $site = Invoke-JobGraph GET "/sites/$($url.Host):$($url.AbsolutePath)?`$select=id,webUrl"
        if ($site.webUrl.TrimEnd('/') -ine $target.siteUrl.TrimEnd('/')) { throw 'Discovered site URL does not match the explicitly approved site.' }
        $sitePath = "/sites/$([uri]::EscapeDataString($site.id))"
        $libraries = @(Get-JobGraphCollection "$sitePath/drives?`$select=id,name,driveType&`$top=200" | Where-Object name -eq $target.libraryName)
        if ($libraries.Count -ne 1 -or $libraries[0].driveType -ne 'documentLibrary') { throw 'The named document library must resolve uniquely within the approved site.' }
        $drive = $libraries[0]
        $folder = Invoke-JobGraph GET "/drives/$([uri]::EscapeDataString($drive.id))/root:/$([uri]::EscapeDataString($target.folderName))"
        if ($folder.root -or $null -eq $folder.folder -or $folder.name -ne $target.folderName -or $folder.parentReference.driveId -ne $drive.id) { throw 'The approved non-root folder could not be verified.' }
        $lists = @(Get-JobGraphCollection "$sitePath/lists?`$select=id,displayName,list&`$top=200" |
            Where-Object { $_.displayName -eq $target.listName -and $_.list.template -eq 'genericList' })
        if ($lists.Count -ne 1) { throw 'The named ordinary list must resolve uniquely within the approved site.' }
        $choices = @($url.AbsoluteUri.TrimEnd('/'),$target.libraryName,$target.folderName,$target.listName) | ForEach-Object { $_.Trim().ToLowerInvariant() }
        $json = ConvertTo-Json -InputObject @($choices) -Compress
        $id = 'sharepoint-' + [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($json))).ToLowerInvariant()
        foreach ($entry in @{ SITE_ID=$site.id; DRIVE_ID=$drive.id; FOLDER_ID=$folder.id; LIST_ID=$lists[0].id }.GetEnumerator()) {
            $bindings[(Get-JobBindingKey $id $entry.Key)] = $entry.Value
        }
        $outcomes += @{ ready=$true; target=$id; durationMs=$watch.ElapsedMilliseconds }
    }
    catch { $outcomes += @{ ready=$false; message=$_.Exception.Message; durationMs=$watch.ElapsedMilliseconds } }
}
$failed = @($outcomes | Where-Object { -not $_.ready })
@{ bindings=$bindings; ready=@($outcomes | Where-Object ready).Count; failures=$failed; outcomes=$outcomes } |
    ConvertTo-Json -Depth 30 | Set-Content $env:MONITORING_SETUP_RESULT
if ($failed.Count) { throw 'SharePoint discovery failed for one or more configured targets.' }
