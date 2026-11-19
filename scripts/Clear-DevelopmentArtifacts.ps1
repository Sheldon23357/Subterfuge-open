# Compatibility entry point: keep a single implementation of cleanup boundaries.
[CmdletBinding(SupportsShouldProcess)]
param([switch]$DryRun, [string]$KeepGameDirectory)
& (Join-Path $PSScriptRoot 'cleanup-runtime.ps1') -DryRun:($DryRun -or $WhatIfPreference) -KeepGameDirectory $KeepGameDirectory
