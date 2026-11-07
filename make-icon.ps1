# Cree TBSA.ico a partir de ic_launcher.png (icone de l'application et de l'installateur)
Add-Type -AssemblyName System.Drawing
$src = [System.Drawing.Image]::FromFile((Join-Path $PSScriptRoot 'ic_launcher.png'))
$bmp = New-Object System.Drawing.Bitmap 48, 48
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.DrawImage($src, 0, 0, 48, 48)
$g.Dispose()
$ico = [System.Drawing.Icon]::FromHandle($bmp.GetHicon())
$fs = [System.IO.File]::Create((Join-Path $PSScriptRoot 'TBSA.ico'))
$ico.Save($fs)
$fs.Close()
Write-Host 'TBSA.ico cree'
