# Farmer's Bridge online

## Rodar
    npm install
    npm start        # http://localhost:3000

## Hospedar (Render / Railway / Fly)
Build: `npm install` · Start: `npm start` · a porta vem de `PORT`.
Contas ficam em `users.json`: use disco persistente (volume) ou troque por um banco.

## Regras ajustáveis (topo do server.js)
- `schedule()`: sequência de rodadas por nº de jogadores
- `TURN_MS`: tempo para palpitar/jogar (60s)
- `RANKS`: ordem das cartas (A,7,K,Q,J,10,9,8,6,5,4,3,2)
