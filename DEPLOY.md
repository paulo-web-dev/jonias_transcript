# Deploy do jonIAs em produção (Docker)

O banco SQLite de produção precisa viver **no volume** (`./data:/app/data`),
apontado por `DB_PATH=/app/data/aula-ai.db`. Antes desta mudança o app gravava
em `/app/aula-ai.db`, dentro da camada do container: todo `docker compose build`
+ `up` recriava o container e o banco voltava ao que estivesse na imagem.

- Parte A: migração **única** do banco vivo para o volume (fazer uma vez).
- Parte B: deploy de rotina, depois da migração.

Convenções nos comandos: `SVC` = nome do serviço no `docker-compose.yml` (veja em
`docker compose ps`); rodar tudo na pasta do `docker-compose.yml` no servidor;
`AAAAMMDD` = data de hoje.

---

## Parte A — migração única do banco para o volume

Faça num horário sem ninguém usando (avise a equipe: nada de edição, marcação
ou importação durante a migração). **Não rode `docker compose down`, `build`,
`rm` nem `up` antes do passo 9.** `stop` é seguro: o container parado guarda o
banco; `down`/`up` com imagem nova o destroem.

### 0. Levantar o estado (só leitura)

```sh
docker compose ps                      # nome do serviço (SVC) e do container
cat docker-compose.yml Dockerfile      # volume ./data:/app/data? env_file? COPY . . ?
ls -la . data/                         # existe data/? já tem algum .db lá?
docker compose exec SVC sh -c 'pwd; id; ls -la /app/*.db* /app/data'
```

Anote: o `WORKDIR` (esperado `/app`), o `uid:gid` do processo (saída de `id`),
e se `data/` já tem um `aula-ai.db`. Se tiver, é um banco antigo e **não** é o
vivo: renomeie antes do passo 6 (`mv data/aula-ai.db data/aula-ai.db.antigo-AAAAMMDD`).

Para confirmar se a imagem atual carrega um banco, rode:

```sh
docker compose images SVC              # nome da imagem
docker run --rm --entrypoint sh <imagem> -c 'ls -la /app/*.db* 2>&1'
```

Se aparecer `aula-ai.db`, a imagem foi construída com um banco dentro. Foi isso
que fez o banco "voltar no tempo". O `.dockerignore` novo impede que se repita.

### 1. Trazer o código novo, SEM build

O `Dockerfile` e o `docker-compose.yml` agora são versionados. O
`docker-compose.yml` do repositório traz `DB_PATH`, `NODE_ENV=production`,
`env_file: .env`, o volume e `init: true`. O que é só do servidor (labels, rede
e domínio do Traefik) vai para `docker-compose.override.yml`, que não é
versionado. O compose lê esse arquivo junto com o principal sem precisar de
nenhum parâmetro. Os arquivos antigos do servidor ainda não são rastreados, e
por isso o `git pull` aborta enquanto eles estiverem na pasta. Tire-os do
caminho antes:

```sh
docker compose config > compose-antigo-AAAAMMDD.txt   # como o compose antigo resolve tudo
mv Dockerfile Dockerfile.antigo
mv docker-compose.yml docker-compose.antigo.yml
git pull                               # só muda arquivos do host; o container em execução não é tocado
ls .dockerignore scripts/banco.js Dockerfile docker-compose.yml   # os quatro precisam existir
```

Monte o override a partir do compose antigo e acerte o nome do serviço:

1. `cp docker-compose.override.example.yml docker-compose.override.yml` e
   troque os valores pelas labels e pela rede que estão em
   `docker-compose.antigo.yml`.
2. **O nome do serviço tem de ser o mesmo do compose antigo.** No repositório
   ele se chama `jonias`. Se o antigo usa outro nome, troque `jonias` por esse
   nome nos dois arquivos (`docker-compose.yml` e override). Com nome
   diferente, o compose não reconhece o container que está rodando e cria um
   novo ao lado dele.
3. Confira:

   ```sh
   docker compose ps                    # tem de listar o container que JÁ está rodando
   docker compose config > compose-novo-AAAAMMDD.txt
   diff compose-antigo-AAAAMMDD.txt compose-novo-AAAAMMDD.txt
   ```

   As diferenças esperadas são estas: `init`, `restart`, `env_file`/
   `environment` (`DB_PATH`, `NODE_ENV`) e o volume `./data`. Labels, rede e
   porta têm de sair iguais. Se o antigo publicava `ports:`, copie esse bloco
   também para o override.

Daqui até o passo 7, os comandos usam o compose novo. Ele só é aplicado ao
container no build do passo 9.

### 2. Retrato "antes" (contagens do banco vivo)

```sh
docker compose exec -T SVC node - conferir /app/aula-ai.db < scripts/banco.js | tee antes-AAAAMMDD.txt
```

O script é enviado pela entrada padrão, então funciona mesmo que a imagem
antiga não o tenha. A saída traz `user_version`, `quick_check` (tem de dizer
`ok`), as contagens de `contatos_ativo` (16.320 esperados), do histórico, das
marcações e das carteiras, e os carimbos mais recentes. No fim vêm as
**últimas importações recusadas com o motivo real**, inclusive o do 422 da
planilha de SC.

### 3. Checkpoint do WAL

```sh
docker compose exec -T SVC node - checkpoint /app/aula-ai.db < scripts/banco.js
```

O resultado esperado é `busy=0`. Com `busy=1`, rode de novo. Isso passa todo o
conteúdo do `-wal` para o `.db`.

### 4. Backup (online, consistente) no volume e fora do servidor

```sh
docker compose exec -T SVC node - backup /app/aula-ai.db /app/data/backup-pre-db-path-AAAAMMDD.db < scripts/banco.js
docker compose exec -T SVC node - conferir /app/data/backup-pre-db-path-AAAAMMDD.db < scripts/banco.js
```

As contagens do backup têm de bater com as de `antes-AAAAMMDD.txt`. Depois,
copie o backup **para fora do servidor** (scp para a sua máquina ou para um
storage). O backup que você já fez continua valendo; este é o do momento exato
da migração.

### 5. Parar o container (stop, NÃO down)

```sh
docker compose stop SVC
docker compose ps -a                   # o container tem de aparecer "exited", não sumir
```

### 6. Copiar o banco vivo para `./data`

```sh
C=$(docker compose ps -a -q SVC)       # id do container parado
docker cp "$C":/app/aula-ai.db     ./data/aula-ai.db
docker cp "$C":/app/aula-ai.db-wal ./data/aula-ai.db-wal 2>/dev/null || true   # pode não existir após o checkpoint
docker cp "$C":/app/aula-ai.db-shm ./data/aula-ai.db-shm 2>/dev/null || true
ls -ln data/
```

Os três arquivos ficam juntos no mesmo diretório. O original continua no
container parado, que funciona como uma segunda cópia até o passo 9.

**Dono dos arquivos:** o processo do container (o `id` do passo 0) precisa
conseguir gravar em `data/` e nos arquivos. Se o `uid` for diferente, rode:

```sh
sudo chown -R <uid>:<gid> data/
```

Se o dono estiver errado, o servidor novo **se recusa a subir** e mostra a
mensagem `✖ BANCO: … não é gravável`. Ele não cria banco vazio.

### 7. Conferir a cópia antes de subir

A conferência roda num container descartável, com o volume montado. Se a
imagem do serviço ainda não existir com o nome novo, o compose a constrói
antes. Isso não faz mal: o container só executa o `banco.js`.

```sh
docker compose run --rm --no-deps -T --entrypoint node SVC - checkpoint /app/data/aula-ai.db < scripts/banco.js
docker compose run --rm --no-deps -T --entrypoint node SVC - conferir   /app/data/aula-ai.db < scripts/banco.js | tee copia-AAAAMMDD.txt
diff antes-AAAAMMDD.txt copia-AAAAMMDD.txt
```

O esperado: mesmo `user_version`, `quick_check ok` e contagens **iguais ou
maiores** que as de antes (maiores só se alguém gravou entre os passos 2 e 5).
Só as linhas `arquivo`/`tamanhos` devem diferir. **Se alguma contagem for
menor, pare aqui.** O container antigo continua parado e intacto; volte com
`docker compose start SVC`.

### 8. Conferir `DB_PATH` e `.env`

O `docker-compose.yml` versionado já define `DB_PATH=/app/data/aula-ai.db` e
`NODE_ENV=production` e monta `./data:/app/data`. Os segredos vêm do `.env`
da pasta por `env_file`. O `.dockerignore` tira o `.env` da imagem, então ele
precisa estar na pasta do compose, ao lado do `docker-compose.yml`:
`ls -la .env`.

`NODE_ENV=production` liga o cookie `secure`, e o login só funciona por
HTTPS. Com o Traefik terminando o TLS, isso é o esperado.

### 9. Build e subida

O `Dockerfile` usa dois estágios. As dependências são instaladas com
`npm ci --omit=dev` (exatamente o `package-lock.json`) num estágio que tem
python3/make/g++, porque `better-sqlite3` e `argon2` compilam quando não há
binário pronto. A imagem final leva só o `node_modules` pronto.

```sh
docker compose build SVC
docker compose up -d SVC
docker compose logs --tail 40 SVC
```

No log, a linha que importa é:

```
🗄  Banco: /app/data/aula-ai.db (DB_PATH) · user_version 28 · 16320 contato(s) de prospecção
```

(`user_version` = a versão das migrações do código que subiu; 28 desde
2026-09-30. Se o banco vinha de uma versão anterior, as linhas `migração N:`
aparecem logo acima — ver a Parte C.)

- `(padrão local)` no lugar de `(DB_PATH)` significa que a variável não chegou
  ao container. Pare (`docker compose stop SVC`) e volte ao passo 8. Nesse modo
  o app cria um banco vazio dentro do container. Com `NODE_ENV=production` isso
  nem chega a acontecer: sem `DB_PATH` o servidor se recusa a subir.
- `✖ BANCO: …` significa que o servidor não subiu e nada foi criado. Corrija o
  caminho ou as permissões e rode `up -d` de novo.
- A contagem de contatos precisa ser a do passo 2.

Confirme também que a imagem nova não carrega banco nenhum:

```sh
docker compose exec SVC sh -c 'ls -la /app/*.db* 2>&1; ls -la /app/data'
```

O primeiro `ls` precisa dizer "No such file". O `/app/data` precisa mostrar
`aula-ai.db`, `-wal`, `-shm` e o backup.

### 10. Conferir depois de subir

```sh
docker compose exec SVC node scripts/banco.js conferir /app/data/aula-ai.db | tee depois-AAAAMMDD.txt
diff copia-AAAAMMDD.txt depois-AAAAMMDD.txt
```

Depois, no navegador: entrar, abrir `/prospeccao` (a aba Trabalho com as
marcações de um vendedor) e `/usuarios` (carteiras).

### 11. Provar que sobrevive a rebuild

```sh
docker compose up -d --force-recreate SVC
docker compose logs --tail 5 SVC       # mesma linha 🗄 Banco, mesmas contagens
```

Se as contagens se mantiverem, o banco está fora do container e o problema
está resolvido. Os arquivos `antes/copia/depois-*.txt` e o backup podem ficar
guardados.

**Voltar atrás (se algo der errado depois do passo 9):**

```sh
docker compose stop SVC
mv data/aula-ai.db data/aula-ai.db.falhou-AAAAMMDD
rm -f data/aula-ai.db-wal data/aula-ai.db-shm
cp data/backup-pre-db-path-AAAAMMDD.db data/aula-ai.db
docker compose start SVC
```

---

## Parte B — deploy de rotina (depois da migração)

1. **Backup antes de cada deploy**:
   ```sh
   docker compose exec -T SVC node scripts/banco.js backup /app/data/aula-ai.db /app/data/backup-AAAAMMDD-HHMM.db
   docker compose exec -T SVC node scripts/banco.js conferir /app/data/aula-ai.db | tee antes.txt
   ```
   Copie o backup para fora do servidor de tempos em tempos.
2. `git pull`, `docker compose build SVC`, `docker compose up -d SVC`.
3. **Conferir**: no `docker compose logs --tail 40 SVC`, a linha `🗄 Banco:`
   precisa mostrar `/app/data/aula-ai.db (DB_PATH)` e a mesma contagem (ou
   maior); depois rode `conferir` e compare com `antes.txt`.

**Nunca:**

- copiar o banco local (`aula-ai.db` da máquina de desenvolvimento) por cima do
  de produção. O local é outra base: tem usuários de teste e não tem o
  trabalho da equipe;
- montar o banco como arquivo único (`./aula-ai.db:/app/aula-ai.db`). O `-wal`
  e o `-shm` ficariam fora do volume;
- apagar ou mover `data/` com o container rodando;
- rodar `git clean -x` na pasta do deploy (apaga `data/`, que está no
  `.gitignore`);
- usar `DB_CRIAR_NOVO=1` em produção. Ele só serve para criar um banco novo e
  vazio de propósito.

---

## Parte C — deploy das migrações 26, 27 e 28 (outubro de 2026)

Vale para o primeiro deploy que leva os commits 5721d3d (Dockerfile/compose
versionados), 42e3b1b (migrações 26 e 27) e 4e6c4a4 (migração 28, Rota do
dia). **Primeiro descubra em que pé está o servidor**:

```sh
docker compose logs SVC 2>&1 | grep "Banco:" | tail -1
```

- Diz `/app/data/aula-ai.db (DB_PATH)` → a Parte A já foi feita: siga a
  Parte B, com as conferências abaixo.
- Diz `(padrão local)`, `/app/aula-ai.db` ou não aparece → a Parte A **ainda
  não foi feita**: faça a Parte A inteira (ela já constrói o código novo no
  passo 9) e use as conferências abaixo no passo 10.

As três migrações rodam sozinhas no boot, uma transação cada; uma que falha
não deixa nada pela metade e o servidor não sobe (o banco fica como estava).

**O que o log do boot precisa mostrar** (entre o build e a linha `🗄 Banco:`):

| Linha | Conferir |
|---|---|
| `migração 26: ramal 2004 com vigência — N ligação(ões) desde 22/09/2026 passaram ao Jhonnata; M seguem do Douglas.` | N + M = `ligações do ramal 2004` do `conferir` de antes. **Anotar N**: é o tamanho da quarta quebra de comparabilidade (CLAUDE.md, `pessoas`) |
| `migração 26: backfill Jhonnata — …` e `Gerencial ganhou "Paulo Sergio Orfanelli" — …` | só informativas (podem não aparecer se for zero) |
| `migração 27: marcação amarela liberada — marcações preservadas: N` | N = `marcacoes_prospeccao` de antes. Se divergir, a migração aborta sozinha com `contagem das marcações divergiu` |
| `migração 28: rota criada — tipo "Licitação" (6 setores, 45/dia); nenhuma campanha vigente até o admin ligar.` | nenhuma rota é gerada enquanto ninguém ligar uma campanha |
| `🗄 Banco: /app/data/aula-ai.db (DB_PATH) · user_version 28 · N contato(s)` | N = `contatos_ativo` de antes |

Depois, `conferir` e `diff antes.txt depois.txt`. O que **pode** mudar:
`user_version` (→ 28), `ramal_vigencias` (→ 2), `rota_tipos` (→ 1),
`rota_campanhas`/`rotas`/`rota_itens` (de "não existe" → 0), `pessoas` (+1,
Jhonnata) e os carimbos/tamanhos. Todo o resto, igual. `marcações por
cor` igual, linha a linha.

**Ligar a Rota do dia (só depois do deploy conferido, em outro momento):**

1. Estoque, só leitura (aceita `"setor1|setor2"` como 2º argumento):
   ```sh
   docker compose exec -T SVC node - /app/data/aula-ai.db < scripts/viabilidade-rota.js | tee viabilidade-AAAAMMDD.txt
   ```
   Olhar: consultores sem carteira (ficam sem rota), dias de estoque por
   consultor e contatos fora de todas as rotas. **SC só entra se a planilha
   de SC estiver importada** — em 2026-09-22 a produção tinha 0 contatos de SC
   (o 422 sem causa conhecida; o motivo aparece em "últimas importações
   recusadas" do `conferir`).
2. Em `/prospeccao` → aba Rota do dia (admin), conferir o painel da campanha e
   escolher "Licitação". Vale a partir da próxima data útil sem rota; as rotas
   saem às 17h (Brasília) para o dia útil seguinte, ou na hora pelo botão
   "gerar".
3. Avisar a equipe: o vendedor passa a abrir `/prospeccao` na aba Rota do dia.

---

## Parte D — meta de pipeline e TV de status/prêmio (migração 29, outubro de 2026)

Vale para o deploy que leva os commits da migração 29 (meta de pipeline) e
das telas novas da TV. A produção já está no volume (Parte A feita): siga a
**Parte B** (backup + `conferir` → `git pull` → build → up) com estas
conferências no log do boot:

| Linha | Conferir |
|---|---|
| `migração 29: N meta(s) preservadas; pipeline_dia = R$ 8.400 desde 05/10; M meta(s) de leads encerradas em 04/10` | N = número de linhas de `metas` antes + 0 (a nova entra depois da contagem). M ≥ 1 (o padrão de leads; mais se alguém tinha meta própria) |
| `… ⚠ K meta(s) de leads com início depois de 04/10 seguem valendo` | só aparece se existir; nesse caso, encerrar em `/metas` |
| `🗄 Banco: /app/data/aula-ai.db (DB_PATH) · user_version 29 · N contato(s)` | N = `contatos_ativo` de antes |

Depois de subir:

1. `/metas`: coluna **📈 Pipeline** com "→ R$ 8.400 a partir de 05/10/2026"
   (até domingo aparece como futura); no histórico, Leads/dia fechada em 04/10.
2. TV: a rotação passa a ser STATUS → RANKING DE VENDAS → SEMANA → RECEITA →
   MÊS → parados. URLs com `?fixo=dia` ou `?fixo=rota` deixam de fixar
   (caem na rotação normal) — trocar por `?fixo=status`. `?festa=demo` mostra
   a festa nova "EM DIA".
3. Até 05/10 o pipeline não tem meta: STATUS mostra só a rota (e sai da
   rotação se não houver rota hoje) e o RANKING mostra os pré-requisitos de
   pipeline como "sem meta" (neutro).
4. Períodos já congelados em `/relatorios` não têm pipeline: recongelar se
   quiser ver as colunas novas e a "Qualidade do pipeline".
