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

# Les images sont DESSINEES par logo.cs, jamais reechantillonnees : chaque taille
# est composee pour elle-meme a partir des contours de la police. C'est ce qui
# evite l'escalier qu'on voyait quand un seul PNG servait a tout.
#
# L'ancienne version derivait icon.ico d'icon.png via GetHicon(), ce qui ne
# produisait qu'UNE taille : Windows reechantillonnait ce 256 px jusqu'en 16 px
# pour la barre des taches. Une icone multi-tailles ne peut pas venir d'un seul
# bitmap, d'ou le generateur. Il se compile avec le meme csc que l'app : aucun
# outil supplementaire a installer.
$ico = Join-Path $ici 'icon.ico'
$genExe = Join-Path $env:TEMP 'recast-logo.exe'
& $csc /nologo /optimize+ "/out:$genExe" /reference:System.Drawing.dll (Join-Path $ici 'logo.cs')
if ($LASTEXITCODE -ne 0) { throw "logo.cs n'a pas compile" }
& $genExe $ici
if ($LASTEXITCODE -ne 0) { throw "generation des icones echouee" }
Remove-Item $genExe -ErrorAction SilentlyContinue

# /target:winexe : application fenetree, donc aucune console noire au lancement
$arguments = @(
    '/nologo'
    '/target:winexe'
    '/optimize+'
    "/out:$sortie"
    # Icone embarquee dans l'executable : sans elle, les raccourcis et
    # l'explorateur affichent l'icone generique. SetupIconFile ne decore que
    # l'installateur, pas l'application.
    "/win32icon:$ico"
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

$taille = [math]::Round((Get-Item $sortie).Length / 1KB)
Write-Host ""
Write-Host "OK : $sortie  ($taille Ko, version $version)"
Write-Host ""
Write-Host "Lancer avec :  .\app\Recast.exe"
