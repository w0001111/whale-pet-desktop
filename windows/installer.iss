#ifndef AppVersion
  #define AppVersion "0.2.0"
#endif
#ifndef ReleaseVersion
  #define ReleaseVersion "0.2.0-windows.1"
#endif
[Setup]
AppId={{4A2753DB-C924-4C64-9C53-721435CA2FBF}
AppName=Whale Pet
AppVersion={#AppVersion}
AppVerName=Whale Pet {#ReleaseVersion}
AppPublisher=Whale Pet Contributors
DefaultDirName={localappdata}\Programs\WhalePet
DefaultGroupName=Whale Pet
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.22000
OutputDir={#OutputDir}
OutputBaseFilename=Whale-Pet-{#ReleaseVersion}-windows-x64-setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
DisableProgramGroupPage=yes
UninstallDisplayIcon={app}\WhalePet.exe
CloseApplications=yes
RestartApplications=no
SetupMutex=WhalePetInstaller
SetupIconFile={#IconFile}
[Languages]
Name: "chinesesimp"; MessagesFile: "{#LanguageFile}"
Name: "english"; MessagesFile: "compiler:Default.isl"
[Files]
Source: "{#StageDir}\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs
[Icons]
Name: "{group}\Whale Pet"; Filename: "{app}\WhalePet.exe"
Name: "{autodesktop}\Whale Pet"; Filename: "{app}\WhalePet.exe"; Tasks: desktopicon
[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; GroupDescription: "其他选项"; Flags: unchecked
[Run]
Filename: "{app}\WhalePet.exe"; Description: "启动 Whale Pet"; Flags: nowait postinstall skipifsilent
