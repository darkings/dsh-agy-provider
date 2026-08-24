$ErrorActionPreference = 'Stop'

$compilerCandidates = @(
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
  (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
)
$compiler = $compilerCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if ($null -eq $compiler) {
  throw 'Microsoft .NET Framework C# compiler was not found; install the Windows .NET Framework developer tools.'
}

$root = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root 'native\windows-launcher\Program.cs'
$outputDirectory = Join-Path $root 'bin\win32-x64'
$output = Join-Path $outputDirectory 'agy-launcher.exe'
New-Item -ItemType Directory -Path $outputDirectory -Force | Out-Null
& $compiler /nologo /target:winexe /platform:x64 /optimize+ "/out:$output" $source
if ($LASTEXITCODE -ne 0) { throw "C# launcher compilation failed with exit code $LASTEXITCODE" }
Write-Output "Built $output"
