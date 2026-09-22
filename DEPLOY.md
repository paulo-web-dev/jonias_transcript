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

```sh
git pull                               # só muda arquivos do host; o container em execução não é tocado
ls .dockerignore scripts/banco.js      # os dois precisam existir
```

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

A conferência usa a imagem antiga, num container descartável, com o volume
montado:

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

### 8. Definir `DB_PATH`

A forma mais explícita é no `docker-compose.yml`, no serviço:

```yaml
    environment:
      - DB_PATH=/app/data/aula-ai.db
    volumes:
      - ./data:/app/data
```

Também funciona pôr `DB_PATH=/app/data/aula-ai.db` no `.env`, se o compose
usa `env_file: .env` ou se o Dockerfile copia o `.env` para a imagem. O log do
passo 9 prova qual delas pegou.

### 9. Build e subida

```sh
docker compose build SVC
docker compose up -d SVC
docker compose logs --tail 40 SVC
```

No log, a linha que importa é:

```
🗄  Banco: /app/data/aula-ai.db (DB_PATH) · user_version 25 · 16320 contato(s) de prospecção
```

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
