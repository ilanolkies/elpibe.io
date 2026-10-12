import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import sharp from 'sharp'

const pages = ['index.html', '2.html']
const staticFiles = ['styles.css', 'favicon.ico', 'CNAME', 'robots.txt', 'ads.txt']
const widths = [640, 1280, 2048]
const sizesByClass = { picture: '100vw', 'four-image': '50vw' }
const ogImageWidth = 1280

const dist = 'dist'

const encoders = {
  avif: (image) => image.avif({ quality: 60 }),
  webp: (image) => image.webp({ quality: 80 }),
  jpg: (image) => image.jpeg({ quality: 82, mozjpeg: true })
}

const mimeTypes = { avif: 'image/avif', webp: 'image/webp' }

const variants = new Map()

const slug = (file) => path.parse(file).name.replace(/\s+/g, '_')

const variantPath = (file, width, format) => `img/w${width}/${slug(file)}.${format}`

const attributesOf = (tag) =>
  Object.fromEntries([...tag.matchAll(/([\w-]+)="([^"]*)"/g)].map(([, name, value]) => [name, value]))

const generate = async (src) => {
  if (variants.has(src)) return variants.get(src)

  const job = (async () => {
    const base = sharp(src, { limitInputPixels: false }).rotate()
    const original = await sharp(src).metadata()
    const rotated = original.orientation >= 5
    const sourceWidth = rotated ? original.height : original.width
    const sourceHeight = rotated ? original.width : original.height

    const outputs = []
    for (const target of widths) {
      const outputWidth = Math.min(target, sourceWidth)
      for (const format of Object.keys(encoders)) {
        outputs.push({ width: outputWidth, format })
      }
    }

    const unique = [...new Map(outputs.map((output) => [`${output.width}.${output.format}`, output])).values()]

    for (const { width: outputWidth, format } of unique) {
      const target = path.join(dist, variantPath(src, outputWidth, format))
      await mkdir(path.dirname(target), { recursive: true })
      await encoders[format](base.clone().resize(outputWidth)).toFile(target)
    }

    return { width: sourceWidth, height: sourceHeight, widths: [...new Set(outputs.map((output) => output.width))] }
  })()

  variants.set(src, job)
  return job
}

const srcset = (src, info, format) =>
  info.widths.map((width) => `${variantPath(src, width, format)} ${width}w`).join(', ')

const render = async (tag, first) => {
  const attributes = attributesOf(tag)
  const src = attributes.src

  if (!src || !src.startsWith('img/')) return tag

  const info = await generate(src)
  const sizes = sizesByClass[attributes.class] ?? '100vw'
  const largest = info.widths[info.widths.length - 1]
  const fallbackWidth = info.widths.includes(1280) ? 1280 : largest

  const sources = Object.keys(mimeTypes)
    .map((format) => `<source type="${mimeTypes[format]}" srcset="${srcset(src, info, format)}" sizes="${sizes}" />`)
    .join('')

  const loading = first ? '' : ' loading="lazy"'
  const itemprop = attributes.itemprop ? ` itemprop="${attributes.itemprop}"` : ''
  const className = attributes.class ? ` class="${attributes.class}"` : ''
  const alt = attributes.alt !== undefined ? ` alt="${attributes.alt}"` : ''

  const img =
    `<img${itemprop} src="${variantPath(src, fallbackWidth, 'jpg')}" srcset="${srcset(src, info, 'jpg')}" sizes="${sizes}"` +
    ` width="${info.width}" height="${info.height}"${loading}${className}${alt} />`

  return `<a href="${encodeURI(src)}"><picture>${sources}${img}</picture></a>`
}

const build = async (page) => {
  let html = await readFile(page, 'utf8')
  const tags = [...html.matchAll(/<img\b[^>]*>/g)].map((match) => match[0])
  const rendered = []

  for (const [index, tag] of tags.entries()) {
    rendered.push(await render(tag, index === 0))
  }

  let cursor = 0
  html = html.replace(/<img\b[^>]*>/g, () => rendered[cursor++])

  const ogImage = html.match(/<meta property="og:image" content="https:\/\/elpibe\.io\/(img\/[^"]+)"/)
  if (ogImage) {
    const info = await generate(decodeURI(ogImage[1]))
    const width = info.widths.includes(ogImageWidth) ? ogImageWidth : info.widths[info.widths.length - 1]
    html = html.replace(ogImage[1], variantPath(decodeURI(ogImage[1]), width, 'jpg'))
  }

  await writeFile(path.join(dist, page), html)
}

await mkdir(dist, { recursive: true })
await cp('img', path.join(dist, 'img'), { recursive: true })

for (const file of staticFiles) {
  await cp(file, path.join(dist, file))
}

for (const page of pages) {
  await build(page)
}
