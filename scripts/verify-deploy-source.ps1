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
$status = ((git status --porcelain) -join "`n").Trim()
if ($status.Length -gt 0) {
    Fail "Working tree is dirty; commit and push before deploying."
}

$upstream = ""
$upstreamSha = ""
if ($env:GITHUB_ACTIONS -eq "true") {
    if ($env:GITHUB_EVENT_NAME -ne "push") {
        Fail "GitHub Actions deploy-source verification requires a push event."
    }
    if (-not $env:GITHUB_REF -or -not $env:GITHUB_REF.StartsWith("refs/heads/")) {
        Fail "GitHub Actions deploy-source verification requires a branch ref."
    }
    if ($env:GITHUB_SHA -ne $currentSha) {
        Fail "GitHub Actions SHA $env:GITHUB_SHA does not match HEAD $currentSha."
    }
    $upstream = $env:GITHUB_REF
    $upstreamSha = ((git ls-remote origin $env:GITHUB_REF) -split "\s+")[0].Trim()
} else {
    $upstream = (git rev-parse --abbrev-ref --symbolic-full-name "@{u}").Trim()
    $upstreamSha = (git rev-parse "@{u}").Trim()
}
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
