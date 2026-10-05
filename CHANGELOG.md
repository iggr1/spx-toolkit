# Changelog

## 1.5.37
- Adiciona a automação **Relatório Parcel Sweeper** na aba Auto Tarefas.
- A cada 1 hora consulta as 5 tarefas mais recentes da estação 5264.
- Tarefas em status 4 têm todas as páginas de pedidos coletadas e sincronizadas.
- Tarefas em status 5 consultam primeiro a planilha; tarefas já completas não são coletadas nem enviadas novamente.
- Quando uma tarefa status 5 ainda não estiver completa, faz uma coleta final e marca a tarefa como completa após confirmar a quantidade de pedidos.
- Cria/atualiza a aba `Relatório Parcel Sweeper` e mantém um controle interno oculto por tarefa.
- Inclui no pacote o Apps Script atualizado em `extension/Code_Conferencia_Automacoes.gs`.

## 1.5.36
- Remove o fundo do ícone enviado pelo usuário e gera os PNGs com transparência.

## 1.5.35
- Substitui os ícones da extensão pelo ícone enviado pelo usuário em 16, 48, 128 e 1024 px.

## 1.5.34
- Corrige nomes de etiquetas que continham `#U00...` e quebravam as URLs no Chrome.
- Remove o `etiquetas.zip` interno duplicado para evitar catálogo desnecessário e reduzir o pacote baixado pelo loader.
- Substitui os ícones por uma chave de boca laranja mais clara em 16, 48, 128 e 1024 px.
- Usa a chave de boca também na aba Operações do painel.
