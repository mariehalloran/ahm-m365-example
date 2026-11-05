. (Join-Path $PSScriptRoot 'job-graph.ps1')
$selected = $script:JobTenant.services.exchange
$targets = @($selected.targets.PSObject.Properties | ForEach-Object { $_.Value.users })
$context = Get-AzContext
$helper = Join-Path $PSScriptRoot 'job-graph.ps1'
$inputPath = $env:MONITORING_SETUP_INPUT
$rows = @($targets | ForEach-Object -ThrottleLimit $selected.execution.maxConcurrentRequests -Parallel {
    $env:MONITORING_SETUP_INPUT = $using:inputPath
    . $using:helper
    $script:JobAzureContext = $using:context
    $target = $_
    $mailbox = $target.mailbox.Trim().ToLowerInvariant()
    $id = Get-JobAccountId $mailbox
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $execution = $script:JobTenant.services.exchange.execution
    $script:GraphDeadline = [DateTimeOffset]::UtcNow.AddSeconds($execution.timeoutSeconds)
    $path = "/users/$([uri]::EscapeDataString($mailbox))"
    $select = 'id,subject,bodyPreview,isDraft,conversationId,internetMessageId,internetMessageHeaders,from,toRecipients,ccRecipients,bccRecipients,replyTo'
    $messageKey = Get-JobBindingKey $id 'REPLY_SEED_MESSAGE_ID'
    $correlationKey = Get-JobBindingKey $id 'REPLY_SEED_CORRELATION_ID'
    $bindings = @{}
    $retained = $null
    $draftId = $null
    $correlation = $null
    $errorMessage = $null
    $cleanupErrors = @()

    # Confirms all recipients and the sender are the selected mailbox; no paired or tenant-wide fixture is accepted.
    function Test-SelfRecipients($Message, [bool]$AllowDraft = $false) {
        $recipients = @($Message.toRecipients) + @($Message.ccRecipients) + @($Message.bccRecipients) + @($Message.replyTo)
        if (@($Message.toRecipients).Count -eq 0 -or @($recipients | Where-Object { $_ -and $_.emailAddress.address -ine $mailbox }).Count) { return $false }
        return $Message.from.emailAddress.address -ieq $mailbox -or ($AllowDraft -and $Message.isDraft -and -not $Message.from)
    }

    # Validates retained received fixture provenance before storing or reusing its binding.
    function Test-Seed($Message, [string]$Correlation, [bool]$AllowDraft = $false) {
        $headers = @($Message.internetMessageHeaders | Where-Object name -ieq 'x-ahm-reply-seed-id')
        $scopes = @($Message.internetMessageHeaders | Where-Object name -ieq 'x-ahm-reply-seed-scope')
        return ($AllowDraft -or -not $Message.isDraft) -and (Test-SelfRecipients $Message $AllowDraft) -and
            $Message.subject -eq "AHM SELF-REPLY seed $Correlation" -and
            $Message.bodyPreview.Contains("Retained self-addressed synthetic reply fixture $Correlation") -and
            $headers.Count -eq 1 -and $headers[0].value -eq $Correlation -and
            $scopes.Count -eq 1 -and $scopes[0].value -eq 'self-v1'
    }

    try {
        $savedId = $script:JobInput.bindings.$messageKey
        $savedCorrelation = $script:JobInput.bindings.$correlationKey
        if ([bool]$savedId -ne [bool]$savedCorrelation) { throw 'Both existing seed binding fields must be set together.' }
        if ($savedId) {
            $saved = Get-OptionalJobGraph "$path/mailFolders/inbox/messages/$([uri]::EscapeDataString($savedId))?`$select=$select"
            if ($saved -and (Test-Seed $saved $savedCorrelation)) { $retained=$saved; $correlation=$savedCorrelation }
            elseif ($saved -and -not $script:JobInput.options.reprovision) { throw 'The saved fixture is not a compatible single-mailbox seed; explicitly approve -Reprovision.' }
        }
        if (-not $retained) {
            $correlation = [guid]::NewGuid().ToString()
            $subject = "AHM SELF-REPLY seed $correlation"
            $draft = Invoke-JobGraph POST "$path/messages" @{
                subject=$subject
                body=@{ contentType='Text'; content="Retained self-addressed synthetic reply fixture $correlation." }
                toRecipients=@(@{emailAddress=@{address=$mailbox}})
                internetMessageHeaders=@(
                    @{ name='x-ahm-reply-seed-id'; value=$correlation }
                    @{ name='x-ahm-reply-seed-scope'; value='self-v1' }
                )
            }
            $draftId = $draft.id
            if (-not $draftId) { throw 'Create-draft response did not contain its owned message ID.' }
            Invoke-JobGraph POST "$path/messages/$([uri]::EscapeDataString($draftId))/send" | Out-Null
            $query = "?`$filter=$([uri]::EscapeDataString("subject eq '$subject'"))&`$select=$select&`$top=100"
            do {
                $inbox = @(Get-JobGraphCollection "$path/mailFolders/inbox/messages$query")
                if ($inbox.Count -gt 1) { throw 'More than one received copy matched the unique fixture; review rather than choosing an arbitrary message.' }
                if ($inbox.Count -eq 1) {
                    if (-not (Test-Seed $inbox[0] $correlation)) { throw 'The received fixture failed its self-addressed correlation/provenance checks.' }
                    $retained = $inbox[0]
                    break
                }
                if ([DateTimeOffset]::UtcNow -ge $script:GraphDeadline) { throw 'The configured fixture-delivery deadline expired.' }
                Start-Sleep -Seconds 2
            } while ($true)
        }
        $bindings[$messageKey] = $retained.id
        $bindings[$correlationKey] = $correlation
    }
    catch { $errorMessage = $_.Exception.Message }
    finally {
        if ($draftId) {
            $script:GraphDeadline = [DateTimeOffset]::UtcNow.AddSeconds($execution.cleanupTimeoutSeconds)
            $owned = [Collections.Generic.HashSet[string]]::new()
            [void]$owned.Add($draftId)
            try {
                $subject = "AHM SELF-REPLY seed $correlation"
                $query = "?`$filter=$([uri]::EscapeDataString("subject eq '$subject'"))&`$select=$select&`$top=100"
                foreach ($copy in @(Get-JobGraphCollection "$path/messages$query")) {
                    if (Test-Seed $copy $correlation $true) { [void]$owned.Add($copy.id) }
                }
            }
            catch { $cleanupErrors += $_.Exception.Message }
            foreach ($messageId in $owned) {
                if ($messageId -eq $retained.id) { continue }
                try { Invoke-JobGraph DELETE "$path/messages/$([uri]::EscapeDataString($messageId))" | Out-Null }
                catch { if ($_.Exception.Response.StatusCode.value__ -ne 404) { $cleanupErrors += $_.Exception.Message } }
            }
        }
    }
    [pscustomobject]@{
        target=$id; ready=(-not $errorMessage -and $cleanupErrors.Count -eq 0)
        bindings=$bindings; durationMs=$watch.ElapsedMilliseconds
        message=$errorMessage; cleanupErrors=$cleanupErrors
    }
})
$bindings = @{}
foreach ($row in $rows) { foreach ($key in $row.bindings.Keys) { $bindings[$key] = $row.bindings[$key] } }
$failed = @($rows | Where-Object { -not $_.ready })
@{ bindings=$bindings; ready=@($rows | Where-Object ready).Count; failures=$failed; outcomes=$rows } |
    ConvertTo-Json -Depth 30 | Set-Content $env:MONITORING_SETUP_RESULT
if ($rows.Count -ne $targets.Count -or $failed.Count) { throw 'Fixture setup did not complete successfully for every configured mailbox.' }
