# Bot de Ventas por Live (PC de la tienda)

Lee el WhatsApp del negocio y pasa a la bandeja «Mío» de FacEx cada mensaje con
**mío / mía** que llegue mientras hay una sesión de Live **Abierta**. Toma el teléfono,
el nombre, la hora del mensaje (que decide el orden de la cola), el personaje
mencionado en el texto y la captura del live. **Solo lee:** no envía mensajes ni los
marca como leídos.

> Aviso: WhatsApp no permite clientes no oficiales y puede bloquear el número.
> Leer sin enviar baja mucho el riesgo, pero no lo elimina.

## Una sola vez

1. En FacEx crear un usuario para el bot (p. ej. `bot.live@neko.local`) con FacEx
   Settings en la compañía y los permisos **Ver página Live y registrar «Mío»** y
   **Crea clientes**. En su ficha de usuario: *Configuración de API → Generar claves*.
2. En la PC instalar **Node.js 18 o más nuevo** (nodejs.org).
3. Copiar esta carpeta `live_bot` a la PC, abrir una terminal en ella y correr:
   ```
   npm install
   ```
   (descarga Chromium, unos 150 MB).
4. Copiar `config.example.json` como `config.json` y pegar la API key y el secret.

## Cada día

```
npm start
```

La primera vez sale un QR: en el teléfono del negocio, *WhatsApp → Dispositivos
vinculados → Vincular un dispositivo*. La sesión queda guardada en `.sesion_wa/`.

- Abra la sesión de Live en FacEx **antes** de empezar el live: solo cuentan los
  mensajes que llegan después de abrirla.
- Si el bot arranca tarde, revisa los chats recientes y registra los «mío» que ya
  llegaron (no duplica).
- Si el mensaje no menciona un personaje de la sesión, queda **Por revisar** en la
  bandeja con su captura.
- Para pedir varios conjuntos: «mío Luffy x2» o «mío Luffy 2 conjuntos».
- La PC debe quedar encendida y con internet durante el live.
