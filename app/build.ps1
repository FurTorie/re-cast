# re:cast - compilation de l'app de barre des tâches
#
# Utilise le compilateur C# livré avec Windows (.NET Framework 4.x) : rien à
# installer, aucun SDK, aucune dépendance npm. Produit un Recast.exe autonome
# de quelques dizaines de Ko.

$ErrorActionPreference = 'Stop'
$ici = Split-Path -Parent $MyInvocation.MyCommand.Path

$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) {
    $csc = "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
}
if (-not (Test-Path $csc)) {
    throw "csc.exe introuvable. Le .NET Framework 4.x doit etre installe (il l'est par defaut sur Windows 10 et 11)."
}

$sortie = Join-Path $ici 'Recast.exe'

# /target:winexe : application fenetree, donc aucune console noire au lancement
$arguments = @(
    '/nologo'
    '/target:winexe'
    '/optimize+'
    "/out:$sortie"
    '/reference:System.dll'
    '/reference:System.Drawing.dll'
    '/reference:System.Windows.Forms.dll'
    (Join-Path $ici 'Recast.cs')
)

Write-Host "Compilation avec $csc"
& $csc $arguments
if ($LASTEXITCODE -ne 0) { throw "Echec de la compilation (code $LASTEXITCODE)" }

$taille = [math]::Round((Get-Item $sortie).Length / 1KB)
Write-Host ""
Write-Host "OK : $sortie  ($taille Ko)"
Write-Host ""
Write-Host "Lancer avec :  .\app\Recast.exe"
