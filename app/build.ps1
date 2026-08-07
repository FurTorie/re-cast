# re:cast - compilation de l'app de barre des tâches
#
# Utilise le compilateur C# livré avec Windows (.NET Framework 4.x) : rien à
# installer, aucun SDK, aucune dépendance npm. Produit un Recast.exe autonome
# de quelques dizaines de Ko.
#
# La version vient de app/version.txt, seule source de vérité : c'est elle qui
# pilote aussi la publication (voir .github/workflows/release-app.yml).

$ErrorActionPreference = 'Stop'
$ici = Split-Path -Parent $MyInvocation.MyCommand.Path

$version = (Get-Content (Join-Path $ici 'version.txt') -Raw).Trim()
if ($version -notmatch '^\d+\.\d+\.\d+$') {
    throw "Version invalide dans version.txt : '$version' (attendu X.Y.Z)"
}

$csc = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) {
    $csc = "$env:WINDIR\Microsoft.NET\Framework\v4.0.30319\csc.exe"
}
if (-not (Test-Path $csc)) {
    throw "csc.exe introuvable. Le .NET Framework 4.x doit etre installe (il l'est par defaut sur Windows 10 et 11)."
}

# Généré à chaque build : la version se voit dans les proprietes du fichier,
# et reste alignee sur version.txt sans duplication a la main.
$infoPath = Join-Path $ici 'AssemblyInfo.generated.cs'
@"
// Fichier genere par build.ps1 - ne pas editer, ne pas versionner.
using System.Reflection;
[assembly: AssemblyTitle("re:cast")]
[assembly: AssemblyProduct("re:cast")]
[assembly: AssemblyDescription("Garde le daemon re:cast en arriere-plan")]
[assembly: AssemblyVersion("$version.0")]
[assembly: AssemblyFileVersion("$version.0")]
"@ | Set-Content -Path $infoPath -Encoding UTF8

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
    # System.Management : lire la ligne de commande d'un autre processus, pour
    # distinguer un daemon re:cast orphelin d'un logiciel tiers sur le meme port
    '/reference:System.Management.dll'
    (Join-Path $ici 'Recast.cs')
    $infoPath
)

Write-Host "Compilation de re:cast $version"
& $csc $arguments
if ($LASTEXITCODE -ne 0) { throw "Echec de la compilation (code $LASTEXITCODE)" }

Remove-Item $infoPath -Force -ErrorAction SilentlyContinue

# icon.ico pour l'installateur, derive du PNG : evite de versionner un binaire
# de plus et garantit que les deux ne divergent jamais.
$ico = Join-Path $ici 'icon.ico'
try {
    Add-Type -AssemblyName System.Drawing
    $bmp = [System.Drawing.Bitmap]::new((Join-Path $ici 'icon.png'))
    $handle = $bmp.GetHicon()
    $icone = [System.Drawing.Icon]::FromHandle($handle)
    $flux = [System.IO.File]::Create($ico)
    $icone.Save($flux)
    $flux.Close()
    $icone.Dispose()
    $bmp.Dispose()
    Write-Host "icon.ico genere"
} catch {
    Write-Warning "icon.ico non genere : $($_.Exception.Message)"
}

$taille = [math]::Round((Get-Item $sortie).Length / 1KB)
Write-Host ""
Write-Host "OK : $sortie  ($taille Ko, version $version)"
Write-Host ""
Write-Host "Lancer avec :  .\app\Recast.exe"
