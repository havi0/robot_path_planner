# Creates "NEXUS Robotics Studio" shortcuts on the Desktop and in the Start Menu.
# Run:  powershell -ExecutionPolicy Bypass -File scripts\install_app.ps1
# Remove: delete the two shortcuts (nothing else is installed).
$root = Split-Path -Parent $PSScriptRoot
$launcher = Join-Path $root "app\nexus_app.pyw"
$icon = Join-Path $root "app\nexus.ico"
$pythonw = (Get-Command pythonw -ErrorAction Stop).Source
$shell = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath("Desktop"), [Environment]::GetFolderPath("Programs"))) {
    $lnk = $shell.CreateShortcut((Join-Path $dir "NEXUS Robotics Studio.lnk"))
    $lnk.TargetPath = $pythonw
    $lnk.Arguments = "`"$launcher`""
    $lnk.WorkingDirectory = $root
    $lnk.IconLocation = "$icon,0"
    $lnk.Description = "NEXUS Robotics Studio - reinforcement-learning robot navigation"
    $lnk.Save()
    Write-Output "Created $($lnk.FullName)"
}
