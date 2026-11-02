# Bot de Ventas por Live (PC de la tienda)

Un bot por número de WhatsApp. Lee ese WhatsApp y pasa a la bandeja «Mío» de FacEx cada mensaje con
**mío / mía** que llegue mientras la sesión de Live **de ese número** está **Abierta**
(campo «WhatsApp del live» de la sesión). Cada vendedor transmite desde su número y
su bot solo llena su sesión: dos lives al mismo tiempo no se mezclan. Toma el teléfono,
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
5. En FacEx Settings de cada vendedor llenar **WhatsApp de mis lives** (se precarga
   en sus sesiones), o escribirlo en la sesión.

### Varios números en la misma PC

Un archivo de config por número (la misma API key sirve para todos) y una terminal
por número:
```
npm start                      (usa config.json)
node index.js config-ana.json
node index.js config-luis.json
```
Cada uno guarda su vinculación aparte en `.sesion_wa/<nombre del config>` y pide su
propio QR la primera vez. También puede correr cada vendedor el bot en su propia PC.

## Cada día

```
npm start
```

La primera vez sale un QR: en el teléfono del negocio, *WhatsApp → Dispositivos
vinculados → Vincular un dispositivo*. La sesión queda guardada en `.sesion_wa/`.

- Abra la sesión de Live en FacEx, con su WhatsApp, **antes** de empezar el live:
  solo cuentan los mensajes que llegan después de abrirla. Un número solo puede
  tener una sesión abierta a la vez.
- Cada minuto (y al arrancar) revisa los chats recientes y registra lo que no haya
  registrado (no duplica).
- Si el mensaje no menciona un personaje de la sesión, queda **Por revisar** en la
  bandeja con su captura.
- Solo un mensaje con «mío» crea un pedido. Lo que el mismo cliente mande sin «mío»
  en los 5 minutos siguientes se le junta a ese pedido: si nombra el personaje que
  faltaba, se lo pone; si es una imagen y el pedido no tenía captura, la usa; lo
  demás (preguntas, tallas, instrucciones) queda en el mensaje del pedido con la
  etiqueta **Consulta** para que el vendedor lo lea. Un «mío» con «?» siempre queda
  Por revisar.
- Para pedir varios conjuntos: «mío Luffy x2» o «mío Luffy 2 conjuntos».
- La PC debe quedar encendida y con internet durante el live.
