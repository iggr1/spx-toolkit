@echo off
setlocal
cd /d "%~dp0"

where gh >nul 2>&1
if errorlevel 1 (
  echo GitHub CLI ^(gh^) nao encontrado.
  echo Instale o GitHub CLI, autentique com "gh auth login" e execute este arquivo novamente.
  pause
  exit /b 1
)

gh auth status >nul 2>&1
if errorlevel 1 (
  echo A conta do GitHub ainda nao esta autenticada no GitHub CLI.
  gh auth login
  if errorlevel 1 exit /b 1
)

gh repo view iggr1/spx-toolkit >nul 2>&1
if errorlevel 1 (
  git remote remove origin >nul 2>&1
  gh repo create iggr1/spx-toolkit --public --source=. --remote=origin --push
) else (
  git remote get-url origin >nul 2>&1
  if errorlevel 1 git remote add origin https://github.com/iggr1/spx-toolkit.git
  git push -u origin main
)

if errorlevel 1 (
  echo.
  echo Falha ao publicar o repositorio.
  pause
  exit /b 1
)

echo.
echo Repositorio publicado em https://github.com/iggr1/spx-toolkit
pause
