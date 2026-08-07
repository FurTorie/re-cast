; re:cast - script d'installation Inno Setup
;
; Produit un installateur .exe autonome contenant l'app de barre des tâches ET le
; daemon Node avec ses dépendances. Node.js lui-même n'est pas embarqué : il doit
; être présent sur la machine, ce que l'installateur vérifie et signale.
;
; La version est passée par la ligne de commande : ISCC /DAppVersion=0.1.0

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

#define AppName "re:cast"
#define AppExe  "Recast.exe"

; Windows interdit ':' dans un nom de fichier ou de dossier. « re:cast » convient
; pour l'affichage, mais tout ce qui touche au systeme de fichiers doit s'en passer.
;
; DirName : sans espace, pour un chemin d'installation sobre.
; ShortcutName : avec espace, c'est ce que l'utilisateur lit sous l'icone.
#define SafeName     "re-cast"
#define ShortcutName "Re Cast"

[Setup]
AppId={{8F3A1C74-6B2E-4D19-9A55-3E7C1D0B4A62}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=re:cast
DefaultDirName={autopf}\{#SafeName}
DefaultGroupName={#ShortcutName}
DisableProgramGroupPage=yes
OutputDir=..\dist
OutputBaseFilename=recast-setup-{#AppVersion}
SetupIconFile=icon.ico
Compression=lzma2/max
SolidCompression=yes
WizardStyle=modern
; Pas de droits administrateur : l'app s'installe pour l'utilisateur courant, ce
; qui suffit et evite une elevation a chaque mise a jour.
PrivilegesRequired=lowest
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayIcon={app}\{#AppExe}

[Languages]
Name: "francais"; MessagesFile: "compiler:Languages\French.isl"

[Tasks]
Name: "demarrage"; Description: "Lancer re:cast au demarrage de Windows"; GroupDescription: "Options :"
Name: "bureau";    Description: "Creer un raccourci sur le bureau"; GroupDescription: "Options :"; Flags: unchecked

[Files]
; App de barre des taches
Source: "Recast.exe";        DestDir: "{app}"; Flags: ignoreversion
Source: "Recast.exe.config"; DestDir: "{app}"; Flags: ignoreversion
Source: "tray.png";          DestDir: "{app}"; Flags: ignoreversion
Source: "icon.png";          DestDir: "{app}"; Flags: ignoreversion

; Daemon complet, dependances comprises : l'app le lance via `node daemon\index.js`
Source: "..\daemon\*"; DestDir: "{app}\daemon"; Flags: ignoreversion recursesubdirs createallsubdirs

; Tous ces noms deviennent des fichiers .lnk : ils utilisent SafeName, jamais
; AppName, sous peine de « Le nom du dossier ne doit contenir aucun des
; caracteres suivants » a l'installation.
; IconFilename explicite : l'icone est embarquee dans l'exe, mais le preciser
; evite tout doute quand l'explorateur a mis en cache l'ancienne icone generique.
[Icons]
Name: "{group}\{#ShortcutName}";              Filename: "{app}\{#AppExe}"; IconFilename: "{app}\{#AppExe}"
Name: "{group}\Desinstaller {#ShortcutName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#ShortcutName}";        Filename: "{app}\{#AppExe}"; IconFilename: "{app}\{#AppExe}"; Tasks: bureau
Name: "{userstartup}\{#ShortcutName}";        Filename: "{app}\{#AppExe}"; IconFilename: "{app}\{#AppExe}"; Tasks: demarrage

[Run]
; Pas de skipifsilent : la mise a jour automatique installe en /SILENT et compte
; sur cette ligne pour relancer l'app, comme le message le promet a l'utilisateur.
Filename: "{app}\{#AppExe}"; Description: "Lancer {#AppName} maintenant"; Flags: nowait postinstall

[UninstallRun]
; Fermer l'app avant desinstallation, sinon les fichiers restent verrouilles
Filename: "{cmd}"; Parameters: "/C taskkill /IM {#AppExe} /F"; Flags: runhidden; RunOnceId: "FermerApp"

[Code]
// Node.js n'est pas embarque : le daemon en a besoin pour tourner. On previent
// plutot que de laisser l'utilisateur decouvrir une app inerte.
function NodePresent(): Boolean;
var
  Chemin: String;
begin
  Result := FileExists(ExpandConstant('{pf}\nodejs\node.exe'))
         or FileExists(ExpandConstant('{pf32}\nodejs\node.exe'))
         or FileExists(ExpandConstant('{localappdata}\Programs\nodejs\node.exe'));

  if not Result then
  begin
    // Dernier recours : chercher dans le PATH
    Chemin := '';
    if RegQueryStringValue(HKEY_CURRENT_USER, 'Environment', 'Path', Chemin) then
      Result := Pos('nodejs', LowerCase(Chemin)) > 0;
  end;
end;

function InitializeSetup(): Boolean;
begin
  Result := True;
  if not NodePresent() then
  begin
    if MsgBox('Node.js ne semble pas installe sur cette machine.' + #13#10#13#10 +
              're:cast en a besoin pour faire tourner son serveur. Vous pouvez ' +
              'poursuivre l''installation et installer Node.js ensuite depuis ' +
              'nodejs.org.' + #13#10#13#10 + 'Continuer quand meme ?',
              mbConfirmation, MB_YESNO) = IDNO then
      Result := False;
  end;
end;
