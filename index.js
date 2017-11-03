const net = require('net')
const md5 = require('md5')
const events = require('events')
const request = require('request-promise')
const REQUEST_TIMEOUT = 10000
const HEARTBEAT_INTERVAL = 30000

class xingyan_danmu extends events {
    constructor(roomid) {
        super()
        this._roomid = roomid
        this._guid = "7773" + ("0000000000000000" + new Date().getTime().toString(16)).substr(-16) + ("000000000000" + parseInt(Math.random() * 1000000000).toString(16)).substr(-12)
    }

    async _get_chat_info() {
        let cluster = 'v3'
        let time = Math.round(new Date().getTime() / 1000)
        let sign = md5(`uzY@H/C!N^G9K:EY${this._guid}${cluster}${time}`)
        let opt = {
            url: `https://online.panda.tv/dispatch?guid=${this._guid}&plat=pc%5Fweb&time=${time}&xid=${this._roomid}&sign=${sign}&cluster=${cluster}`,
            timeout: REQUEST_TIMEOUT,
            json: true,
            gzip: true
        }
        try {
            let body = await request(opt)
            return body
        } catch (e) {
            return null
        }
    }

    async start() {
        if (this._starting) {
            return
        }
        this._starting = true
        this._chat_info = await this._get_chat_info()
        if (!this._chat_info || !this._chat_info.addr || !this._chat_info.port) {
            this.emit('error', new Error('Fail to get chat info'))
            return this.emit('close')
        }
        this._start_tcp()
    }

    _start_tcp() {
        this._client = new net.Socket()
        this._client.connect(parseInt(this._chat_info.port), this._chat_info.addr)
        this._client.on('connect', () => {
            this.emit('connect')
            this._bind_user()
        })
        this._client.on('error', err => {
            this.emit('error', err)
        })
        this._client.on('close', () => {
            this._stop()
            this.emit('close')
        })
        this._client.on('data', this._on_data.bind(this))
    }

    _bind_user() {
        let head = Buffer.alloc(12)
        head.writeUInt8(3)
        head.writeUInt8(0, 1)
        head.writeUInt8(0, 2)
        head.writeUInt8(0, 3)
        head.writeDoubleBE(Math.random(), 4)
        let body = Buffer.from('800000010000000000000024', 'hex')
        let buf = Buffer.concat([Buffer.from(this._guid, 'hex'), Buffer.from(this._chat_info.rnd, 'hex')])
        let all_buf = Buffer.concat([head, body, buf])
        try {
            this._client.write(all_buf)
        } catch (err) {
            this.emit('error', err)
        }
    }

    _on_data(data) {
        while (data.length > 0) {
            let ignore_len = 22
            data = data.slice(ignore_len)
            let msg_len = data.readInt16BE(0)
            let msg = data.slice(2, 2 + msg_len)
            data = msg.slice(2 + msg_len)
            this._format_msg(msg)
        }
    }

    _format_msg(msg) {
        try {
            msg = JSON.parse(msg)
        } catch (e) {
            return this.emit('error', e)
        }
        let msg_obj
        if (msg.type === 'chat' && msg.to == this._roomid) {
            let msg_obj = {
                type: 'chat',
                time: new Date().getTime(),
                from: {
                    name: msg.from.nick,
                    rid: msg.from.rid + '',
                    level: msg.from.level_now,
                    plat: msg.plat
                },
                content: msg.data.text,
                raw: msg
            }
        } else if (msg.personnum && msg.xid == this._roomid) {
            let msg_obj = {
                type: 'online',
                time: new Date().getTime(),
                count: parseInt(msg.personnum),
                raw: msg
            }
        } else if (msg.starval && msg.xid == this._roomid) {
            let msg_obj = {
                type: 'starval',
                time: new Date().getTime(),
                count: parseInt(msg.starval),
                raw: msg
            }
        } else if (msg.type === 'gift' && msg.to == this._roomid) {
            let msg_obj = {
                type: 'gift',
                time: new Date().getTime(),
                name: msg.data.gift_name,
                from: {
                    name: msg.from.nick,
                    rid: msg.from.rid + '',
                    level: msg.from.level_now
                },
                count: parseInt(msg.data.count),
                raw: msg
            }
        } else if (msg.type === "bamboo" && msg.to == this._roomid) {
            let count_array = msg.data.text.match(/(\d+)/)
            let count = parseInt(count_array[1])
            let msg_obj = {
                type: 'gift',
                time: new Date().getTime(),
                name: '竹子',
                from: {
                    name: msg.from.nick,
                    rid: msg.from.rid + '',
                    level: msg.from.level_now
                },
                count: count,
                raw: msg
            }
        } else {
            msg_obj = {
                type: 'other',
                time: new Date().getTime(),
                raw: msg
            }
        }
        return this.emit('message', msg_obj)
    }

    _stop() {
        this._starting = false
        try {
            this._client.destroy()
        } catch (e) { }
    }

    stop() {
        this.removeAllListeners()
        this._stop()
    }
}

module.exports = xingyan_danmu