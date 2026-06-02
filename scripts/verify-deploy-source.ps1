param(
    [string]$ExpectedSha = "",
    [string]$DeployedShaFile = "DEPLOYED_GIT_SHA"
)

$ErrorActionPreference = "Stop"

function Fail($Message) {
    Write-Error $Message
    exit 1
}

$currentSha = (git rev-parse HEAD).Trim()
$status = (git status --porcelain).Trim()
if ($status.Length -gt 0) {
    Fail "Working tree is dirty; commit and push before deploying."
}

$upstream = (git rev-parse --abbrev-ref --symbolic-full-name "@{u}").Trim()
$upstreamSha = (git rev-parse "@{u}").Trim()
if ($currentSha -ne $upstreamSha) {
    Fail "HEAD $currentSha does not match upstream $upstream at $upstreamSha."
}

if ($ExpectedSha -and $ExpectedSha -ne $currentSha) {
    Fail "Expected SHA $ExpectedSha does not match HEAD $currentSha."
}

if (Test-Path $DeployedShaFile) {
    $deployedSha = (Get-Content $DeployedShaFile -Raw).Trim()
    if ($deployedSha -and $deployedSha -ne $currentSha) {
        Fail "DEPLOYED_GIT_SHA $deployedSha does not match HEAD $currentSha."
    }
}

Write-Output "deploy_source_ok sha=$currentSha upstream=$upstream deployed_sha_file=$DeployedShaFile"
