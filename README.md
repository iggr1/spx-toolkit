# SPX Toolkit

Repositório oficial da extensão **SPX Toolkit**.

A extensão fica em `extension/`. Os computadores dos usuários não precisam substituir a pasta manualmente: o **SPX Toolkit Loader** consulta este repositório e sincroniza a instalação local.

## Estrutura

```text
extension/               Extensão Chrome MV3
.github/workflows/       Validação automática do repositório
tools/                   Scripts auxiliares de publicação
```

## Publicar uma atualização

1. Altere os arquivos em `extension/`.
2. Execute `tools/PUBLICAR_ATUALIZACAO.bat` no Windows.
3. O script incrementa a versão `patch` do `manifest.json`, valida o JSON, cria o commit e executa `git push`.
4. Os loaders instalados consultam `main` periodicamente e sincronizam a nova versão.

Também é possível fazer `git add`, `git commit` e `git push` normalmente. O loader usa o SHA do commit remoto, portanto qualquer novo commit em `main` é suficiente para disparar a atualização, mesmo sem alterar a versão do manifest.

## Instalação nos computadores

Use o pacote separado **SPX Toolkit Loader**. Na primeira instalação ele baixa `extension/` para:

```text
%LOCALAPPDATA%\SPX Toolkit\extension
```

No Chrome, ative o modo do desenvolvedor em `chrome://extensions` e carregue essa pasta com **Carregar sem compactação**. Isso é necessário apenas uma vez por computador.

O loader mantém a mesma pasta e substitui o conteúdo quando houver um novo commit. A atualização passa a valer no próximo recarregamento da extensão ou na próxima abertura do Chrome.

## Repositório esperado pelo loader

```text
https://github.com/iggr1/spx-toolkit
```

Branch: `main`.

## Ícone

Os ícones da extensão foram substituídos por uma chave de boca laranja em 16, 48 e 128 px.
