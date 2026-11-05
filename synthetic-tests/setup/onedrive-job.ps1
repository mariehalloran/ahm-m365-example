. (Join-Path $PSScriptRoot 'job-graph.ps1')
$settings = $script:JobTenant.services.onedrive.setup
$targets = @($script:JobTenant.services.onedrive.targets.PSObject.Properties | ForEach-Object { $_.Value.users })
$worker = [string]$script:JobInput.options.workerClientId
$context = Get-AzContext
$helper = Join-Path $PSScriptRoot 'job-graph.ps1'
$inputPath = $env:MONITORING_SETUP_INPUT
$rows = @($targets | ForEach-Object -ThrottleLimit $settings.concurrency -Parallel {
    $env:MONITORING_SETUP_INPUT = $using:inputPath
    . $using:helper
    $script:JobAzureContext = $using:context
    $target = $_
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $script:GraphDeadline = [DateTimeOffset]::UtcNow.AddSeconds($script:JobTenant.services.onedrive.setup.targetTimeoutSeconds)
    $id = Get-JobAccountId $target.userPrincipalName
    try {
        if (-not $target.folderName) { throw 'Each selected folder needs its root-configured folderName.' }
        $workerClientId = $using:worker
        $user = Invoke-JobGraph GET "/users/$([uri]::EscapeDataString($target.userPrincipalName))?`$select=id"
        $drive = Invoke-JobGraph GET "/users/$([uri]::EscapeDataString($target.userPrincipalName))/drive?`$select=id,driveType"
        if ($drive.driveType -ne 'business') { throw 'The selected account did not resolve to a OneDrive for Business drive.' }
        $drivePath = "/drives/$([uri]::EscapeDataString($drive.id))"
        $root = Invoke-JobGraph GET "$drivePath/root?`$select=id"
        $folderKey = Get-JobBindingKey $id 'FOLDER_ID'
        $driveKey = Get-JobBindingKey $id 'DRIVE_ID'
        $savedFolder = $script:JobInput.bindings.$folderKey
        $savedDrive = $script:JobInput.bindings.$driveKey
        if ($savedDrive -and $savedDrive -ne $drive.id) { throw 'The saved drive binding no longer matches the configured account.' }
        $path = $savedFolder ? "$drivePath/items/$([uri]::EscapeDataString($savedFolder))" : "$drivePath/root:/$([uri]::EscapeDataString($target.folderName))"
        $folder = Get-OptionalJobGraph $path
        if (-not $folder -and $savedFolder) { throw 'A bound folder is missing; review the stale binding explicitly before recreating it.' }
        if (-not $folder) {
            try { $folder = Invoke-JobGraph POST "$drivePath/root/children" @{ name=$target.folderName; folder=@{}; '@microsoft.graph.conflictBehavior'='fail' } }
            catch {
                if ($_.Exception.Response.StatusCode.value__ -notin @($null, 409, 500, 502, 503, 504)) { throw }
                $folder = Get-OptionalJobGraph $path
                if (-not $folder) { throw }
            }
        }
        if ($null -eq $folder.folder -or $folder.root -or $folder.id -eq $root.id -or
            $folder.name -ne $target.folderName -or $folder.parentReference.driveId -ne $drive.id -or
            (-not $savedFolder -and $folder.parentReference.id -ne $root.id)) { throw 'The selected folder is not the approved non-root child of the configured drive.' }
        $collection = "$drivePath/items/$([uri]::EscapeDataString($folder.id))/permissions"
        # Checks all returned application identities; an inherited writable grant needs no mutation.
        function Select-WorkerPermissions($Permissions) {
            @($Permissions | Where-Object {
                $ids = @($_.grantedToV2.application.id) + @($_.grantedToIdentitiesV2 | ForEach-Object { $_.application.id })
                $ids -icontains $workerClientId
            })
        }
        $existing = Select-WorkerPermissions @(Get-JobGraphCollection $collection)
        $writable = @($existing | Where-Object { @($_.roles | Where-Object { $_.ToLowerInvariant() -in @('write','owner','fullcontrol') }).Count })
        if (-not $writable.Count) {
            $direct = @($existing | Where-Object { -not $_.inheritedFrom })
            if ($direct.Count) { Invoke-JobGraph PATCH "$collection/$([uri]::EscapeDataString($direct[0].id))" @{ roles=@('write') } | Out-Null }
            else { Invoke-JobGraph POST $collection @{ grantedToV2=@{application=@{id=$workerClientId}}; roles=@('write') } | Out-Null }
            for ($attempt=0; $attempt -lt 5; $attempt++) {
                $observed = Select-WorkerPermissions @(Get-JobGraphCollection $collection)
                $writable = @($observed | Where-Object { @($_.roles | Where-Object { $_.ToLowerInvariant() -in @('write','owner','fullcontrol') }).Count })
                if ($writable.Count) { break }
                Start-Sleep -Milliseconds (500 * [Math]::Pow(2,$attempt))
            }
            if (-not $writable.Count) { throw 'The scoped write grant did not become observable before the setup deadline.' }
        }
        $bindings = @{}
        $bindings[(Get-JobBindingKey $id 'USER_ID')] = $user.id
        $bindings[$driveKey] = $drive.id
        $bindings[$folderKey] = $folder.id
        [pscustomobject]@{ target=$id; ready=$true; bindings=$bindings; durationMs=$watch.ElapsedMilliseconds }
    }
    catch { [pscustomobject]@{ target=$id; ready=$false; bindings=@{}; durationMs=$watch.ElapsedMilliseconds; message=$_.Exception.Message } }
})
$bindings = @{}
foreach ($row in $rows) { foreach ($key in $row.bindings.Keys) { $bindings[$key] = $row.bindings[$key] } }
$failed = @($rows | Where-Object { -not $_.ready })
@{ bindings=$bindings; ready=@($rows | Where-Object ready).Count; failures=$failed; outcomes=$rows } |
    ConvertTo-Json -Depth 30 | Set-Content $env:MONITORING_SETUP_RESULT
if ($rows.Count -ne $targets.Count -or $failed.Count) { throw 'OneDrive setup did not complete successfully for every configured account.' }
