$git = "D:\Andres Varela\git\cmd\git.exe"
$repoPath = $PSScriptRoot

Write-Output "Configuring remote origin for medica-colombia-bot..."
& $git -C $repoPath remote remove origin -ErrorAction SilentlyContinue
& $git -C $repoPath remote add origin "https://github.com/mvmareja2003-cpu/medica-colombia-bot.git"

Write-Output "Pushing to https://github.com/mvmareja2003-cpu/medica-colombia-bot.git..."
& $git -C $repoPath push -u origin main
