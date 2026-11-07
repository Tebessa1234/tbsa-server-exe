; Installateur TBSA-Serveur (Inno Setup 6)
#ifndef AppVer
  #define AppVer "3.5.0"
#endif

[Setup]
AppId={{B7A5C0F2-5E5B-4C11-9C0D-7B1F3E8A4D21}
AppName=TBSA-Serveur
AppVersion={#AppVer}
AppPublisher=TBSA
DefaultDirName={autopf}\TBSA-Serveur
DisableProgramGroupPage=yes
OutputDir=dist
OutputBaseFilename=TBSA-Serveur-Setup
SetupIconFile=TBSA.ico
UninstallDisplayIcon={app}\TBSA-Serveur.exe
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible
ArchitecturesAllowed=x64compatible

[Languages]
Name: "french"; MessagesFile: "compiler:Languages\French.isl"

[Tasks]
Name: "desktopicon"; Description: "Créer un raccourci sur le bureau"; GroupDescription: "Raccourcis :"
Name: "autostart"; Description: "Lancer TBSA-Serveur automatiquement au démarrage de Windows (recommandé)"; GroupDescription: "Fonctionnement :"

[Files]
Source: "dist\TBSA-Serveur-Core.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\TBSA-Serveur.exe"; DestDir: "{app}"; Flags: ignoreversion
Source: "TBSA.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "dist\TBSA-Serveur.apk"; DestDir: "{app}"; Flags: ignoreversion skipifsourcedoesntexist

[Icons]
Name: "{autoprograms}\TBSA-Serveur"; Filename: "{app}\TBSA-Serveur.exe"
Name: "{autodesktop}\TBSA-Serveur"; Filename: "{app}\TBSA-Serveur.exe"; Tasks: desktopicon
Name: "{commonstartup}\TBSA-Serveur"; Filename: "{app}\TBSA-Serveur.exe"; Parameters: "--silent"; Tasks: autostart

[Run]
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""TBSA-Serveur"""; Flags: runhidden
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall add rule name=""TBSA-Serveur"" dir=in action=allow program=""{app}\TBSA-Serveur-Core.exe"" enable=yes profile=private,domain"; Flags: runhidden
Filename: "{app}\TBSA-Serveur.exe"; Description: "Lancer TBSA-Serveur maintenant"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{sys}\netsh.exe"; Parameters: "advfirewall firewall delete rule name=""TBSA-Serveur"""; Flags: runhidden; RunOnceId: "DelFirewall"

[Code]
procedure StopTBSA;
var
  rc: Integer;
begin
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /T /IM TBSA-Serveur.exe', '', SW_HIDE, ewWaitUntilTerminated, rc);
  Exec(ExpandConstant('{sys}\taskkill.exe'), '/F /T /IM TBSA-Serveur-Core.exe', '', SW_HIDE, ewWaitUntilTerminated, rc);
  Sleep(800);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopTBSA;
  Result := '';
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
    StopTBSA;
  if CurUninstallStep = usPostUninstall then
  begin
    if MsgBox('Voulez-vous aussi supprimer vos données (réglages, profils, bibliothèques, notes) ?' + #13#10 + #13#10 +
              'Choisissez Non pour les conserver : elles seront retrouvées si vous réinstallez TBSA-Serveur.',
              mbConfirmation, MB_YESNO or MB_DEFBUTTON2) = IDYES then
      DelTree(ExpandConstant('{userappdata}\TBSA-Serveur'), True, True, True);
  end;
end;
