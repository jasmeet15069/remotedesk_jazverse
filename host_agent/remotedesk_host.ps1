$ErrorActionPreference = "Stop"

$Server = "https://remotedesk.jazverse.online"
$Code = Read-Host "Enter approved RemoteDesk session code"

if ([string]::IsNullOrWhiteSpace($Code)) {
  Write-Host "Session code is required."
  Read-Host "Press Enter to exit"
  exit 1
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Send-Stop {
  try {
    Invoke-RestMethod -Uri "$Server/api/screen/stop" -Method Post -ContentType "application/json" -Body "{}" | Out-Null
  } catch {
  }
}

function Capture-Frame {
  $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)

  try {
    $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bounds.Size)

    $maxWidth = 960
    if ($bitmap.Width -gt $maxWidth) {
      $scale = $maxWidth / $bitmap.Width
      $targetWidth = [int]($bitmap.Width * $scale)
      $targetHeight = [int]($bitmap.Height * $scale)
      $resized = New-Object System.Drawing.Bitmap $targetWidth, $targetHeight
      $resizedGraphics = [System.Drawing.Graphics]::FromImage($resized)
      try {
        $resizedGraphics.DrawImage($bitmap, 0, 0, $targetWidth, $targetHeight)
      } finally {
        $resizedGraphics.Dispose()
        $bitmap.Dispose()
      }
      $bitmap = $resized
    }

    $stream = New-Object System.IO.MemoryStream
    try {
      $bitmap.Save($stream, [System.Drawing.Imaging.ImageFormat]::Jpeg)
      return "data:image/jpeg;base64," + [Convert]::ToBase64String($stream.ToArray())
    } finally {
      $stream.Dispose()
    }
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
}

Write-Host ""
Write-Host "RemoteDesk Host is visible and active."
Write-Host "Keep this window open. Press Ctrl+C or close it to stop sharing."
Write-Host ""

try {
  while ($true) {
    try {
      $frame = Capture-Frame
      $payload = @{
        code = $Code
        image = $frame
      } | ConvertTo-Json -Compress

      Invoke-RestMethod -Uri "$Server/api/screen/frame" -Method Post -ContentType "application/json" -Body $payload | Out-Null
      Write-Host ("Frame sent at " + (Get-Date -Format "HH:mm:ss"))
    } catch {
      Write-Host ("Waiting for approved screen session: " + $_.Exception.Message)
    }

    Start-Sleep -Milliseconds 900
  }
} finally {
  Send-Stop
}
