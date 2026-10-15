# Native Windows enrollment. Claude/Harness run on Windows; WSL is not used.
[CmdletBinding()]
param(
    [Parameter(Mandatory=$true)][string]$Server,
    [Parameter(Mandatory=$true)][string]$Code,
    [switch]$NoService
)
$ErrorActionPreference='Stop'
$env:PYTHONUTF8='1'
$installer=$null
try {
    $uri=[Uri]$Server
    if (-not $uri.IsAbsoluteUri -or $uri.Scheme -notin @('http','https') -or $uri.UserInfo -or $uri.Query -or $uri.Fragment -or $uri.AbsolutePath -ne '/') { throw 'Use only the platform origin as Server.' }
    if ($Code -notmatch '^[0-9a-fA-F-]{36}:[0-9a-f]{64}$') { throw 'Invalid enrollment code. Generate a fresh command on the Seats page.' }
    if ([Environment]::OSVersion.Version.Build -lt 17763) { throw 'Native seats require Windows 10 1809+ or Windows 11 (ConPTY).' }
    $python=$null
    $pythonArgs=@()
    foreach($candidate in @('py.exe','python.exe','python3.exe')) {
        if (Get-Command $candidate -ErrorAction SilentlyContinue) {
            $prefix=@();if($candidate -eq 'py.exe'){$prefix=@('-3')}
            & $candidate @prefix -c 'import sys; sys.exit(0 if sys.version_info >= (3,10) else 1)'
            if($LASTEXITCODE -eq 0){$python=$candidate;$pythonArgs=$prefix;break}
        }
    }
    if(-not $python){throw 'Install 64-bit Python 3.10+ from python.org (include pip), then reopen PowerShell.'}
    & $python @pythonArgs -c "import importlib.util,sys; sys.exit(0 if importlib.util.find_spec('winpty') else 1)"
    if($LASTEXITCODE -ne 0){
        Write-Host 'Installing pywinpty for native Windows pseudoconsole support (no admin required).'
        $pipArgs=@('-m','pip','install','--only-binary=:all:','pywinpty>=2.0.15,<4')
        & $python @pythonArgs -c 'import sys; sys.exit(0 if sys.prefix != sys.base_prefix else 1)'
        if($LASTEXITCODE -ne 0){$pipArgs+='--user'}
        & $python @pythonArgs @pipArgs
        if($LASTEXITCODE -ne 0){throw 'Cannot install pywinpty. Check pip access or use an approved internal wheel mirror.'}
    }
    Write-Host 'Using native Windows Claude and Harness. Existing local model settings are preserved.'
    $installer=Join-Path ([IO.Path]::GetTempPath()) ('paperclip-seat-'+[Guid]::NewGuid().ToString('N')+'.py')
    Invoke-WebRequest -UseBasicParsing -Uri ($Server.TrimEnd('/')+'/dsp7-install.py') -OutFile $installer
    $installArgs=@($installer,'--server',$Server,'--code',$Code)
    if($NoService){$installArgs+='--no-service'}
    & $python @pythonArgs @installArgs
    if($LASTEXITCODE -ne 0){throw 'Enrollment did not complete. See the message above; existing configuration is preserved.'}
} finally {
    if($installer){Remove-Item -LiteralPath $installer -ErrorAction SilentlyContinue}
}
