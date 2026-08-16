@ECHO off
SETLOCAL
SET "_pnpm_node=node"
IF DEFINED DEEPSEEK_HARNESS_DESKTOP_NODE SET "_pnpm_node=%DEEPSEEK_HARNESS_DESKTOP_NODE%"
"%_pnpm_node%" "%~dp0..\pnpm\bin\pnpm.mjs" %*
