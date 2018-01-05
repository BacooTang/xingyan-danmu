const net = require('net')
const md5 = require('md5')
const events = require('events')
const request = require('request-promise')
const socks = require('socks').SocksClient
const socks_agent = require('socks-proxy-agent')
const REQUEST_TIMEOUT = 10000
const HEARTBEAT_INTERVAL = 30000
const REFRESH_GIFT_INFO_INTERVAL = 30 * 60 * 1000

class xingyan_danmu extends events {
    constructor(roomid, proxy) {
        super()
        this._roomid = roomid
        this._gift_info = {}
        this._guid = "7773" + ("0000000000000000" + new Date().getTime().toString(16)).substr(-16) + ("000000000000" + parseInt(Math.random() * 1000000000).toString(16)).substr(-12)
        this.set_proxy(proxy)
    }

    set_proxy(proxy) {
        this._agent = null
        if (proxy) {
            this._proxy = proxy
            let auth = ''
            if (proxy.name && proxy.pass)
                auth = `${proxy.name}:${proxy.pass}@`
            let socks_url = `socks://${auth}${proxy.ip}:${proxy.port || 8080}`
            this._agent = new socks_agent(socks_url)
        }
    }

    async _get_chat_info() {
        let cluster = 'v3'
        let time = Math.round(new Date().getTime() / 1000)
        let sign = md5(`uzY@H/C!N^G9K:EY${this._guid}${cluster}${time}`)
        let opt = {
            url: `https://online.panda.tv/dispatch?guid=${this._guid}&plat=pc%5Fweb&time=${time}&xid=${this._roomid}&sign=${sign}&cluster=${cluster}`,
            timeout: REQUEST_TIMEOUT,
            json: true,
            gzip: true,
            agent: this._agent
        }
        try {
            let body = await request(opt)
            return body
        } catch (e) {
            return null
        }
    }

    async _get_host_info() {
        let opt = {
            url: `http://m.api.xingyan.panda.tv/room/baseinfo?xid=${this._roomid}`,
            timeout: REQUEST_TIMEOUT,
            json: true,
            gzip: true,
            agent: this._agent
        }
        try {
            let body = await request(opt)
            return body.data
        } catch (e) {
            return null
        }
    }

    async _get_gift_info() {
        let opt = {
            url: `https://gift.xingyan.panda.tv/gifts?__plat=pc_web&hostid=${this._hostid}&__version=1.11.7&_=${new Date().getTime()}`,
            timeout: REQUEST_TIMEOUT,
            json: true,
            gzip: true,
            agent: this._agent
        }
        try {
            let body = await request(opt)
            let gift_info = {}
            body.data.forEach(g => {
                gift_info[g.id] = {
                    name: g.name,
                    price: g.price
                }
            })
            return gift_info
        } catch (e) {
            return null
        }
    }

    async _refresh_gift_info() {
        let gift_info = await this._get_gift_info()
        if (gift_info) {
            this._gift_info = gift_info
        } else {
            this.emit('error', new Error('Fail to get gift info'))
        }
    }

    async start() {
        if (this._starting) return
        this._starting = true
        this._chat_info = await this._get_chat_info()
        if (!this._chat_info || !this._chat_info.addr || !this._chat_info.port) {
            this.emit('error', new Error('Fail to get chat info'))
            return this.emit('close')
        }
        this._host_info = await this._get_host_info()
        if (!this._host_info) {
            this.emit('error', new Error('Fail to get host info'))
            return this.emit('close')
        }
        this._hostid = this._host_info.roominfo.rid
        let gift_info = await this._get_gift_info()
        if (!gift_info) {
            this.emit('error', new Error('Fail to get gift info'))
            return this.emit('close')
        }
        this._gift_info = gift_info
        this._refresh_gift_info_timer = setInterval(this._refresh_gift_info.bind(this), REFRESH_GIFT_INFO_INTERVAL)
        this._start_tcp()
    }

    async _start_tcp() {
        const on_connect = () => {
            this.emit('connect')
            this._bind_user()
        }
        if (this._proxy) {
            let options = {
                proxy: {
                    ipaddress: this._proxy.ip,
                    port: this._proxy.port,
                    type: 5
                },
                command: 'connect',
                destination: {
                    host: this._chat_info.addr,
                    port: parseInt(this._chat_info.port)
                },
                timeout: 30000
            }
            options.userId = this._proxy.name || null
            options.password = this._proxy.pass || null
            try {
                let info = await socks.createConnection(options)
                this._client = info.socket
                on_connect()
            } catch (e) {
                this.emit('error', e)
            }
        } else {
            this._client = new net.Socket()
            this._client.connect(parseInt(this._chat_info.port), this._chat_info.addr)
            this._client.on('connect', on_connect)
        }
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
        data = data.toString()
        let start = 0
        let index = 0
        for (let i = 0; i < data.length; i++) {
            if (data[i] === '{') {
                index++ || (start = i)
            } else if (data[i] === '}') {
                if (!--index) {
                    this._format_msg(data.substring(start, i + 1))
                }
            }
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
            msg_obj = {
                type: 'chat',
                time: new Date().getTime(),
                from: {
                    name: msg.from.nick,
                    rid: msg.from.rid + '',
                    level: msg.from.level_now,
                    plat: msg.plat
                },
                id: md5(JSON.stringify(msg)),
                content: msg.data.text,
                raw: msg
            }
        } else if (msg.personnum && msg.xid == this._roomid) {
            msg_obj = {
                type: 'online',
                time: new Date().getTime(),
                count: parseInt(msg.personnum),
                raw: msg
            }
        } else if (msg.starval && msg.xid == this._roomid) {
            msg_obj = {
                type: 'starval',
                time: new Date().getTime(),
                count: parseInt(msg.starval),
                raw: msg
            }
        } else if (msg.type === 'gift' && msg.to == this._roomid) {
            let gift = this._gift_info[msg.data.gift_id] || { price: 0, name: msg.data.gift_name }
            let price = gift.price
            let count = parseInt(msg.data.count)
            msg_obj = {
                type: 'gift',
                time: new Date().getTime(),
                name: msg.data.gift_name,
                from: {
                    name: msg.from.nick,
                    rid: msg.from.rid + '',
                    level: msg.from.level_now
                },
                id: md5(JSON.stringify(msg)),
                price: price * count,
                price: price * count * 0.1,
                count: count,
                raw: msg
            }
        } else if (msg.type === "bamboo" && msg.to == this._roomid) {
            let count_array = msg.data.text.match(/(\d+)/)
            let count = parseInt(count_array[1])
            msg_obj = {
                type: 'gift',
                time: new Date().getTime(),
                name: '竹子',
                from: {
                    name: msg.from.nick,
                    rid: msg.from.rid + '',
                    level: msg.from.level_now
                },
                id: md5(JSON.stringify(msg)),
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
        clearInterval(this._refresh_gift_info_timer)
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