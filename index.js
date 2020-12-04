const { EventEmitter } = require('events')
const raf = require('random-access-file')
const MerkleTree = require('./lib/merkle-tree')
const BlockStore = require('./lib/block-store')
const Bitfield = require('./lib/bitfield')
const Replicator = require('./lib/replicator')

const inspect = Symbol.for('nodejs.util.inspect.custom')

module.exports = class Omega extends EventEmitter {
  constructor (storage) {
    super()

    this.storage = defaultStorage(storage)
    this.tree = null
    this.blocks = null
    this.bitfield = null
    this.replicator = new Replicator(this)

    this.key = null
    this.discoveryKey = null
    this.opened = false

    this.opening = this.ready()
    this.opening.catch(noop)
  }

  [inspect] (depth, opts) {
    let indent = ''
    if (typeof opts.indentationLvl === 'number') {
      while (indent.length < opts.indentationLvl) indent += ' '
    }

    return 'Omega(\n' +
      indent + '  key: ' + opts.stylize((this.key && this.key.toString('hex')), 'string') + '\n' +
      indent + '  discoveryKey: ' + opts.stylize((this.discoveryKey && this.discoveryKey.toString('hex')), 'string') + '\n' +
      indent + '  opened: ' + opts.stylize(this.opened, 'boolean') + '\n' +
      indent + '  length: ' + opts.stylize(this.length, 'number') + '\n' +
      indent + '  byteLength: ' + opts.stylize(this.byteLength, 'number') + '\n' +
      indent + ')'
  }

  replicate () {
    return this.replicator.createStream()
  }

  get length () {
    return this.tree === null ? 0 : this.tree.length
  }

  get byteLength () {
    return this.tree === null ? 0 : this.tree.byteLength
  }

  async proof (request) {
    if (this.opened === false) await this.opening

    const p = await this.tree.proof(request)

    if (request.block) {
      p.block.value = request.block.value ? await this.blocks.get(request.block.index) : null
    }

    return p
  }

  async verify (response, peer) {
    if (this.opened === false) await this.opening

    const len = this.tree.length
    let downloaded = false

    const b = this.tree.batch()
    await b.verify(response)

    // TODO: if upgrade, check sigs...

    b.commit()

    const { block } = response
    if (block && block.value && !this.bitfield.get(block.index)) {
      downloaded = true
      await this.blocks.put(block.index, block.value)
    }

    await this.tree.flush()

    if (block && block.value) {
      this.bitfield.set(block.index, true)
      await this.bitfield.flush()
    }

    if (downloaded) {
      this.emit('download', block.index, block.value, peer)
    }

    if (this.tree.length !== len) {
      this.emit('append')
    }
  }

  async ready () {
    if (this.opening) return this.opening

    this.tree = await MerkleTree.open(this.storage('tree'))
    this.blocks = new BlockStore(this.storage('data'), this.tree)
    this.bitfield = await Bitfield.open(this.storage('bitfield'))
    this.opened = true
  }

  async update () {

  }

  async seek (bytes) {
    if (this.opened === false) await this.opening

    const s = this.tree.seek(bytes)

    return (await s.update()) || this.replicator.requestSeek(s)
  }

  async has (index) {
    if (this.opened === false) await this.opening

    return this.bitfield.get(index)
  }

  async get (index) {
    if (this.opened === false) await this.opening

    return this.bitfield.get(index) ? this.blocks.get(index) : this.replicator.requestBlock(index)
  }

  download (range) {
    return this.replicator.requestRange(range.start, range.end, !!range.linear)
  }

  async append (datas) {
    if (this.opened === false) await this.opening

    if (!Array.isArray(datas)) datas = [datas]
    if (!datas.length) return

    const b = this.tree.batch()
    const all = []

    for (const data of datas) {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
      b.append(buf)
      all.push(buf)
    }

    await this.blocks.putBatch(this.tree.length, all)

    b.commit()

    await this.tree.flush()

    for (let i = this.tree.length - datas.length; i < this.tree.length; i++) {
      this.bitfield.set(i, true)
    }

    await this.bitfield.flush()

    // TODO: should just be one broadcast
    for (let i = this.tree.length - datas.length; i < this.tree.length; i++) {
      this.replicator.broadcastBlock(i)
    }
  }
}

function noop () {}

function defaultStorage (storage) {
  if (typeof storage === 'string') return name => raf(name, { directory: storage })
  return storage
}
