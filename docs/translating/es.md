# Español (`es`): style for Combwork

**Status:** drafted by AI (Claude, October 2026, card #854), not yet reviewed by a native speaker. Its entry in
`src/shared/i18n/languages.ts` says the same (`ai: true` until it is reviewed).

**In the language picker:** Español, marked (IA) while drafted by AI, with the note *Traducido por IA: las mejoras son
bienvenidas.*

**Improving it:** this translation was drafted by an AI model and has not been checked by a native speaker yet, so
some wording will be stiff or wrong. Corrections are very welcome: edit `locales/es/<area>.json`, run
`npm run i18n:check` (it must pass), and open a pull request on
[Suremise/combwork](https://github.com/Suremise/combwork) saying what you changed and why. A change to a
term in the table below changes it everywhere: change this page first, then every message that uses it. Once a
native speaker has reviewed the whole language, its `ai` flag comes off.

## Voice

Combwork's English is plain and direct: short sentences, everyday words, *you* for the reader, and it says what happens.
Translate the meaning, not the words, and keep the result as short and plain.

- **Neutral international Spanish:** words understood from Mexico to Spain. No *vosotros* and no *vos*: the plural
  "you" is *ustedes*. Prefer *archivo* (not *fichero*), *agregar* (not *añadir*), *PC* (not *equipo*, *ordenador*
  or *computadora*: see Terms), *costo* (not *coste*), *hacer clic*, *pegar*, *usar*.
- **Addressing the reader:** the informal *tú* (*Elige un proyecto*, *tus agentes*), as Spanish software usually does.
  Never *usted*. *Tú* is written in lower case.
- **Tone:** friendly and direct, never casual. Prefer active sentences: *Combwork guarda la sesión*, not *La sesión es
  guardada por Combwork*. Avoid bureaucratic phrasing (*proceder a*, *efectuar*, *realizar* where *hacer* works).
- **Sentence length:** keep one English sentence as one Spanish sentence where it reads well; split a long one rather
  than chain *que* clauses. Spanish runs about 20% longer than English: in buttons, titles and column headings,
  choose the shorter word.

## Buttons, commands, titles

- **Buttons and menu commands:** the infinitive (*Guardar*, *Agregar agente…*, *Mostrar notas compartidas*). The same
  form everywhere, including the command palette.
- **Capitalisation:** sentence case everywhere: titles, buttons, menus, headings, tabs, settings and column names
  (*Configuración del agente*, *Reiniciar y actualizar Combwork*). Don't copy the English Title Case. Names of products and
  the glossary's kept names keep theirs.
- **A trailing `…`** (the command asks something before it acts) stays, with no space before it: *Quitar agente…*.
  Always the single character …, never three dots.
- **Column headings** (the 1.0 stages, glossary-1.0 §2.2): *En espera*, *Pendiente*, *En curso* (Active, was Doing),
  *Revisión*, *Aprobado* (Approved, was Passed), with *Fusionando* (Merging) inside Aprobado, and *Hecho*. In running
  text name the column (*en la columna Revisión*, *pasa a Hecho*) so a sentence never reads *en En curso*.
- **Where things are:** paths through menus and settings keep Combwork's arrows, with each name as Combwork shows it in Spanish:
  *Configuración → Proveedores*, *Ayuda → Configuración de proveedores*.

## Grammar

- **Names have no known gender.** Agents' names (*One*, *Codex*, *Builder*) and people's names don't say how a word
  must agree. Put the noun first, so it carries the gender (*el agente {agent}*, *la tarjeta #{n}*), or use an
  impersonal form (*Se quitó {agent}*). Example: *{agent} was removed* → *Se quitó el agente {agent}*, not *{agent}
  fue quitado*.
- **Cards are feminine** (*la tarjeta*): *bloqueada*, *estancada*, *archivada*, *movida*. Agents are masculine
  (*el agente*), sessions feminine (*la sesión*), worktrees masculine (*el worktree*).
- **Plurals:** Spanish's plural categories are *one*, *many* and *other* (CLDR). *many* is for large round numbers
  (1 000 000), which Spanish says like *other*. Every plural message gives all three, *many* the same as *other*:
  `{n, plural, one {# tarjeta} many {# tarjetas} other {# tarjetas}}`. Exact cases from the English (`=0`) stay.
- **Cases and placeholders:** a placeholder like `{project}` or `{agent}` is a name inserted as it is. Write the noun
  before it where the sentence needs an article or preposition: *en el proyecto {project}*, *para el agente {agent}*.
- **Lists:** Combwork joins lists itself (*One, Two y Three*). Never write *y* or *o* into a message around a list
  placeholder.
- **Questions and exclamations** open with *¿* and *¡*.

## Punctuation and typography

- **Quotation marks:** “…” (comillas inglesas tipográficas), as most Spanish software does, and ‘…’ inside them.
  Never the straight `"`.
- **Apostrophe:** Spanish has none. In a kept English name (*Don't ask* is translated, so this is rare) use ’.
- **Spaces:** none before : ; ? !, as in English.
- **Dashes, colons, ellipsis:** as in the English. The colon is followed by a lower-case letter unless a name or a
  full quotation follows.
- **Numbers, dates, money, durations:** formatted by Combwork in the reader's locale. Never write them into a message.

## Terms

The words Spanish uses for Combwork's terms ([glossary.md](glossary.md)). Use them every time. Where a term is kept in
English, it says so.

| English | Español | Notes |
|---|---|---|
| workspace | espacio de trabajo | |
| project | proyecto | |
| agent | agente | Masculine: *el agente {agent}*. |
| provider | proveedor | |
| session | sesión | Starting an agent's session: *iniciar* / *empezar una sesión nueva*; *iniciar sesión* alone means signing in (below). |
| the Assistant | el Asistente | Capitalised. Its only name: the full English name *Hive Assistant* went with the rename (HI-2458). |
| persona (now: working mode) | modo (modo de trabajo) | The Assistant's personas became *modes*; the old *persona* is *personaje*. |
| task board / board | tablero de tareas / tablero | The *Tasks* tab is *Tareas*. |
| card | tarjeta | Never *tarea* in running text. |
| On Hold / Todo / Active / Review / Approved / Merging / Done | En espera / Pendiente / En curso / Revisión / Aprobado / Fusionando / Hecho | Stages and categories (1.0: Active was Doing, Approved was Passed). *Hecho* means merged (or accepted); *Aprobado*, passed review but not merged. *Stage*: *etapa*; *category*: *categoría*. |
| decision | decisión | |
| blocked / stalled | bloqueada / estancada | Of a card. |
| builder / reviewer / either | autor / revisor / ambos | The builder is who does the card's work (not who created it: *creada por*). Never *constructor*. |
| card loop / lane / round | ciclo de tarjetas / carril / ronda | Never *bucle*. *Start lane…*: *Iniciar carril…*. |
| verdict / pass / fail | veredicto / superada / no superada | A reviewer's pass is *superada* (*supera la revisión*, *la revisión superada*), never *aprobada*: *aprobación* is only your OK. |
| approval / Approve | aprobación / Aprobar | Your OK on a card (G10, For you). |
| For you (Decide / Test / Approve / Sign in) | Para ti (Decidir / Probar / Aprobar / Iniciar sesión) | |
| revision | versión | An exact state of the work (a commit, a hash). Never *revisión*, which is Review. A *release* is a *lanzamiento*. |
| change / same change / carries over / stale | cambio / el mismo cambio / se mantiene / caducada | *Stale* of a pass: *caducada*. |
| check / checks before review / merge checks | comprobación / comprobaciones antes de la revisión / comprobaciones de fusión | |
| review copy | copia de revisión | *Check copy*: *copia de comprobación*. |
| merge queue / test merge | cola de fusión / fusión de prueba | *Pause queue* / *Resume queue*: *Pausar la cola* / *Reanudar la cola*. |
| merge slot | turno de fusión | Only the agents' own merges; Combwork's merges are the *cola de fusión*. |
| slot / pool / ready | slot / grupo / listo | *Slot* is kept, masculine (*el slot*). |
| Version Control (the tab) / version control | Control de versiones / control de versiones | |
| workflow / workflow options | flujo de trabajo / opciones del flujo de trabajo | |
| preset (Solo, Pair, Team, Custom) | ajuste predefinido (Individual, Pareja, Equipo, Personalizado) | |
| computer / PC / this machine | PC | Masculine: *el PC*, *este PC*, *tu PC*, *reinicia el PC*. Never *equipo*, which is the team (the Team preset, *Pausar el equipo*), nor *ordenador* or *computadora*. |
| team | equipo | Only the agents' team or the Team preset, never the computer. |
| None (no version control) | Ninguno | |
| rule / old rules | regla / reglas anteriores | |
| refused / override / Move anyway | rechazado / excepción / Mover de todos modos | |
| returned (to its builder) | devuelta | Of a card. |
| no-code card / before 1.0 / outside Combwork | tarjeta sin código / anterior a 1.0 / fuera de Combwork | |
| target branch / up to date / repository root | rama de destino / al día / raíz del repositorio | |
| work (a card's Work section) / deliverables | trabajo / entregables | |
| project key | clave del proyecto | |
| in flight (a card) | en marcha | Not *en curso*, which is the column. |
| inbox / message / wake | bandeja de entrada / mensaje / despertar | *Wake* as a verb is *despertar* (*Combwork despierta al revisor*); as a noun, *aviso* (*un aviso del ciclo*). |
| handover / shared notes | traspaso / notas compartidas | |
| skill / template | habilidad / plantilla | A skill's own name (`work-on-card`) is kept. |
| worktree / branch / commit / merge | worktree / rama / commit / fusionar, fusión | *worktree* and *commit* are kept, masculine (*el worktree*, *los commits*; *hacer commit*). *Remote*: *remoto*. *Push*, *pull*, *fetch*, *rebase* are kept as git's commands: *hacer push*. *Repository*: *repositorio*. |
| Progress panel / run | panel Progreso / ejecución | A test *suite* is *suite*. |
| Workspace Overview | Resumen del espacio de trabajo | |
| permission mode (Manual, Accept edits, Plan, Auto, Don't ask) | modo de permisos (Manual, Aceptar ediciones, Plan, Auto, No preguntar) | *Ask* is *Preguntar*. The CLIs' own screens stay in English. |
| effort / usage / cost / tokens | esfuerzo / uso / costo / tokens | *Cache*: *caché*; *context*: *contexto*; *usage limit*: *límite de uso*. |
| banner / notification / tip | banner / notificación / consejo | *Banner* as in Windows' Spanish (*banners de notificación*). |
| sign in | iniciar sesión | *Signed in*: *con la sesión iniciada*; *sign out*: *cerrar sesión*. |
| compact, compaction | compactar, compactación | |
| transcript | transcripción | |
| hook | hook | Kept, masculine (*los hooks*). |
| prompt | prompt | Kept, masculine: what is typed to an agent. A *permission prompt* is a *solicitud de permiso*. |
| terminal | terminal | Feminine: *la terminal*. |
| pane / tab / layout | panel / pestaña / diseño | |
| status bar / activity bar / sidebar / footer | barra de estado / barra de actividad / barra lateral / pie | |
| command palette | paleta de comandos | |
| tray | área de notificación | |
| Recycle Bin | Papelera de reciclaje | As Windows says it. |
| resume | reanudar | |
| idle / working / waiting / stopped | inactivo / trabajando / esperando / detenido | Of an agent. |
| settings | configuración | Settings → … is *Configuración → …*; *Agent Settings* is *Configuración del agente*. |

## Examples

| English | Español |
|---|---|
| Remove agent… | Quitar agente… |
| {name} has {n, plural, one {# open card} other {# open cards}} | {name} tiene {n, plural, one {# tarjeta abierta} many {# tarjetas abiertas} other {# tarjetas abiertas}} |
| {agent} was removed. Its sessions stay in the Sessions tab. | Se quitó el agente {agent}. Sus sesiones siguen en la pestaña Sesiones. |
| Combwork was started in {language} (--lang): this setting applies from its next start. | Combwork se inició en {language} (--lang): esta configuración se aplica a partir del próximo inicio. |

## Checking

- `npm run i18n:check` passes, and `npm run i18n:coverage` shows what is still missing or outdated.
- Look at the screenshots: `npm run e2e -- --lang es --build`, in both themes, for text that is cut off or wraps
  badly. Spanish runs longer than English: settings titles, the board's column headings and the agent strip's
  buttons are where it shows first. The first check (October 2026) shortened these: the Todo column is *Pendiente*
  (*Por hacer* wrapped in its heading), a pane's *Session ended.* is *Terminada.*, the agent state on a card is
  *Sin ejecutar*, and long settings titles start with the verb (*Mantener los banners de un agente que te espera*).
- **Messages with `{what}`** (*Could not load {what}*) take a noun phrase that can be singular or plural: write them
  so nothing agrees with it (*Error al cargar {what}*), never *No se pudo cargar {what}*.
- A reviewer should look first at the terms above (above all *tarjeta*, *autor* / *revisor*, *carril*), at
  agreement with names, and at the settings' titles, which other messages quote.
