# Clones every GitHub origin listed on https://webmcp.devpost.com/resources
# into <repo>/resources/<name>, then writes resources/clone-manifest.tsv.
# Idempotent: an existing clone is fetched, not wiped.
param(
    [string]$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
)

$ErrorActionPreference = 'Continue'
$PSNativeCommandUseErrorActionPreference = $false

$listPath = Join-Path $PSScriptRoot 'webmcp-resource-repos.txt'
$destRoot = Join-Path $RepoRoot 'resources'
$manifestPath = Join-Path $destRoot 'clone-manifest.tsv'

New-Item -ItemType Directory -Force -Path $destRoot | Out-Null

function Invoke-Git {
    param([string[]]$GitArgs)
    & git @GitArgs | Out-Host
    if ($LASTEXITCODE -ne 0) {
        throw "git $($GitArgs -join ' ') failed with exit $LASTEXITCODE"
    }
}

function Get-GitLine {
    param([string[]]$GitArgs)
    $line = (& git @GitArgs | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "git $($GitArgs -join ' ') failed with exit $LASTEXITCODE"
    }
    return $line
}

$entries = Get-Content -LiteralPath $listPath |
    Where-Object { $_ -and ($_ -notmatch '^\s*#') } |
    ForEach-Object {
        $parts = $_ -split "`t"
        if ($parts.Count -lt 3) { throw "bad repo list row: $_" }
        [pscustomobject]@{
            Name    = $parts[0].Trim()
            Url     = $parts[1].Trim()
            Recurse = $parts[2].Trim() -eq '1'
        }
    }

if ($entries.Count -eq 0) { throw "no repos in $listPath" }

$results = foreach ($entry in $entries) {
    $name = $entry.Name
    $url = $entry.Url
    $path = Join-Path $destRoot $name
    $gitDir = Join-Path $path '.git'
    try {
        if (Test-Path -LiteralPath $gitDir) {
            Invoke-Git -GitArgs @('-C', $path, 'remote', 'set-url', 'origin', $url)
            Invoke-Git -GitArgs @('-C', $path, 'fetch', '--prune', 'origin')
            $default = & git -C $path rev-parse --abbrev-ref origin/HEAD
            if ($LASTEXITCODE -ne 0) {
                Invoke-Git -GitArgs @('-C', $path, 'remote', 'set-head', 'origin', '-a')
                $default = Get-GitLine -GitArgs @('-C', $path, 'rev-parse', '--abbrev-ref', 'origin/HEAD')
            }
            $branch = ([string]$default).Trim() -replace '^origin/', ''
            Invoke-Git -GitArgs @('-C', $path, 'checkout', $branch)
            Invoke-Git -GitArgs @('-C', $path, 'pull', '--ff-only', 'origin', $branch)
            if ($entry.Recurse) {
                Invoke-Git -GitArgs @('-C', $path, 'submodule', 'update', '--init', '--recursive')
            }
            $action = 'updated'
        } else {
            if (Test-Path -LiteralPath $path) {
                Remove-Item -LiteralPath $path -Recurse -Force
            }
            $cloneArgs = @('clone')
            if ($entry.Recurse) { $cloneArgs += '--recurse-submodules' }
            $cloneArgs += @($url, $path)
            Invoke-Git -GitArgs $cloneArgs
            $action = 'cloned'
        }

        $sha = Get-GitLine -GitArgs @('-C', $path, 'rev-parse', 'HEAD')
        $origin = Get-GitLine -GitArgs @('-C', $path, 'remote', 'get-url', 'origin')
        $head = Get-GitLine -GitArgs @('-C', $path, 'rev-parse', '--abbrev-ref', 'HEAD')
        $remoteLine = Get-GitLine -GitArgs @('ls-remote', $url, 'HEAD')
        $remoteSha = (($remoteLine -split '\s+') | Select-Object -First 1)
        if (-not $sha) { throw "no HEAD sha for $name" }
        if ($origin -ne $url) { throw "origin mismatch for ${name}: ${origin} vs ${url}" }
        if ($sha -ne $remoteSha) { throw "HEAD mismatch for ${name}: local $sha remote $remoteSha" }

        [pscustomobject]@{
            Ok        = $true
            Name      = $name
            Url       = $origin
            Path      = $path
            Sha       = $sha
            RemoteSha = $remoteSha
            Head      = $head
            Recurse   = $entry.Recurse
            Action    = $action
            Error     = ''
        }
    } catch {
        [pscustomobject]@{
            Ok        = $false
            Name      = $name
            Url       = $url
            Path      = $path
            Sha       = ''
            RemoteSha = ''
            Head      = ''
            Recurse   = $entry.Recurse
            Action    = 'failed'
            Error     = "$_"
        }
    }
}

$lines = @('name	origin	path	sha	remote_sha	head	action	ok	error')
foreach ($r in $results) {
    $err = [string]$r.Error -replace "`t|`r|`n", ' '
    $lines += "$($r.Name)`t$($r.Url)`t$($r.Path)`t$($r.Sha)`t$($r.RemoteSha)`t$($r.Head)`t$($r.Action)`t$($r.Ok)`t$err"
}
[System.IO.File]::WriteAllLines($manifestPath, $lines)

$results | Format-Table Name, Action, Head, Sha, Ok -AutoSize
Write-Host "manifest $manifestPath"

$failed = @($results | Where-Object { -not $_.Ok })
if ($failed.Count -gt 0) {
    $failed | ForEach-Object { Write-Host "FAIL $($_.Name) $($_.Error)" }
    exit 1
}

exit 0
