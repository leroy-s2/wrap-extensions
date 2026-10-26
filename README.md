# wrap-extensions

Mirror del repositorio de extensiones de [Keiyoushi](https://github.com/keiyoushi/extensions) en el formato clásico `index.min.json`, pensado para Aniyomi (y clientes que todavía no aceptan `index.pb`).

## Qué hace

Cada 12 horas, GitHub Actions:

1. Descarga `index.pb` desde `https://raw.githubusercontent.com/keiyoushi/extensions/repo/index.pb`.
2. Lo descomprime (gzip) y lo decodifica con `protobufjs` usando `index.proto`.
3. Genera:
   - `index.min.json`: índice clásico con `name`, `pkg`, `apk`, `lang`, `code`, `version`, `nsfw` y `sources`.
   - `repo.json`: metadatos que Aniyomi/Mihon leen antes del índice.
   - `apk/`: APKs espejados desde los GitHub Releases de Keiyoushi.
   - `icon/`: iconos en `<repo>/icon/<paquete>.png`.
4. Hace commit y push de los cambios.

Aniyomi construye las URLs a partir de una base. La opción que funciona ahora por HTTPS es `raw.githubusercontent.com`:

| Recurso | URL |
| --- | --- |
| Base | `https://raw.githubusercontent.com/leroy-s2/wrap-extensions/main` |
| Índice | `<base>/index.min.json` |
| APK | `<base>/apk/<archivo>.apk` |
| Icono | `<base>/icon/<paquete>.png` |

Por eso el repo no solo publica el JSON: también espeja los APKs y los iconos.

## Puesta en marcha

1. El repo ya está creado: `https://github.com/leroy-s2/wrap-extensions`.
2. En GitHub, ve a **Settings → Actions → General → Workflow permissions** y elige **Read and write permissions** (necesario para que el workflow haga push).
3. El workflow ya se ejecutó una vez y dejó publicados `index.min.json`, `repo.json`, `apk/` e `icon/`. Para regenerarlos, ve a **Actions → Update extension index → Run workflow**. La primera ejecución descarga ~1.400 APKs e iconos (~100–150 MB) y puede tardar varios minutos.
4. (Opcional) Puedes habilitar **Settings → Pages → Deploy from a branch → main / (root)**. Pages queda en `https://lrydev.me/wrap-extensions/`, pero el dominio personalizado `lrydev.me` todavía no tiene certificado HTTPS; mientras eso no se resuelva, usa la URL raw.
5. Comprueba que el índice exista:
   `https://raw.githubusercontent.com/leroy-s2/wrap-extensions/main/index.min.json`
6. En Aniyomi, agrega el repositorio con esa URL **completa**:
   `https://raw.githubusercontent.com/leroy-s2/wrap-extensions/main/index.min.json`

   Aniyomi exige HTTPS y que la URL termine en `/index.min.json`; la base se deduce sola.

En Mihon también puedes agregar la misma URL completa; `repo.json` está incluido para ese caso.

### GitHub Pages y el dominio `lrydev.me`

El repo `leroy-s2.github.io` tiene configurado el dominio personalizado `lrydev.me`. Por eso `https://leroy-s2.github.io/wrap-extensions/...` redirige a `http://lrydev.me/wrap-extensions/...`, y ese dominio aún no tiene certificado HTTPS (`The certificate does not exist yet`). Aniyomi no acepta `http://`, así que la URL raw es la opción recomendada.

Si más adelante el certificado de `lrydev.me` se aprovisiona, también podrás usar:

`https://lrydev.me/wrap-extensions/index.min.json`

> Si ya tienes el repositorio oficial de Keiyoushi agregado, Aniyomi puede avisar de un fingerprint duplicado porque los APKs son los originales. Reemplaza el repo oficial por este.

## Programación

El workflow `.github/workflows/update.yml` corre cada 12 horas:

```yaml
schedule:
  - cron: "0 */12 * * *"
```

Para cada 24 horas, cámbialo a:

```yaml
schedule:
  - cron: "0 0 * * *"
```

También puedes lanzarlo a mano desde **Actions → Update extension index → Run workflow**.

## Ejecución local

Requiere Node.js 20+.

```bash
npm ci
npm run convert
```

Para probar solo la conversión del índice, sin descargar APKs ni iconos:

```bash
SKIP_ASSETS=1 npm run convert
```

Variables opcionales:

- `SKIP_ASSETS=1`: no espeja `apk/` ni `icon/`.
- `CONCURRENCY=8`: descargas simultáneas (por defecto 8).

## Cómo se mapea el protobuf

`index.proto` reproduce el esquema real de Keiyoushi (verificado contra el `index.pb` y su `index.json`):

- `ExtensionIndex.extension_list.extensions[]`
- `Extension.name` → `name`
- `Extension.package_name` → `pkg`
- `Extension.resources.apk_url` → nombre de archivo en `apk`
- `Extension.version_code` → `code`
- `Extension.version_name` → `version`
- `Extension.content_warning == CONTENT_WARNING_NSFW` → `nsfw: 1` (resto `0`)
- `Extension.sources[]` → `sources[]` (`id` como string, `language` → `lang`, `home_url` → `baseUrl`)

El `lang` del índice se deduce así: si el paquete está en la carpeta `all`, es `all`; si todas las fuentes comparten un idioma, se usa ese (por ejemplo `pt-BR`); en caso contrario, se usa la carpeta del paquete (`en`, `es`, `zh`, …).

## Integridad

Los APKs se verifican con el `sha256` de `release-assets.json`. Si un archivo cambia, se vuelve a descargar. Los APKs e iconos que ya no existen en el índice se eliminan para mantener el repo pequeño.

## Límites y notas

- La URL raw de GitHub sirve el repo por HTTPS sin depender de Pages; es la opción recomendada mientras `lrydev.me` no tenga certificado.
- GitHub Pages: 1 GB de sitio publicado y ~100 GB/mes de tráfico. Este repo ronda los 100–150 MB.
- El repo es público (requisito de Pages).
- GitHub puede pausar workflows programados tras 60 días sin actividad; este workflow se ejecuta y commitea cada 12 h, así que se mantiene activo.
- Los APKs son los originales de Keiyoushi; este repo solo los espeja.

## Solución de problemas

- **El workflow no hace push**: revisa los permisos de Actions (paso 2).
- **Aniyomi dice URL inválida**: usa `https://raw.githubusercontent.com/leroy-s2/wrap-extensions/main/index.min.json` (HTTPS y termina en `/index.min.json`).
- **Pages redirige a `lrydev.me` y falla por HTTPS**: el dominio personalizado del sitio de usuario no tiene certificado; usa la URL raw.
- **Las extensiones aparecen pero no instalan**: verifica que `apk/` esté en la rama `main` y que el workflow haya terminado.
- **Los iconos no cargan**: revisa que `icon/` esté en la rama `main`; si faltó alguno, vuelve a ejecutar el workflow.
- **Keiyoushi cambió el protobuf**: actualiza `index.proto` y el mapeo en `scripts/convert.mjs`.
