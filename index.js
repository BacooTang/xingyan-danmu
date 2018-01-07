const net = require('net')
const url = require('url')
const md5 = require('md5')
const delay = require('delay')
const events = require('events')
const request = require('request-promise')
const socks = require('socks').SocksClient
const socks_agent = require('socks-proxy-agent')

const timeout = 30000
const close_delay = 100
const heartbeat_interval = 30000
const fresh_gift_interval = 60 * 60 * 1000
const r = request.defaults({ json: true, gzip: true, timeout: timeout })

class xingyan_danmu extends events {
    constructor(opt) {
        super()
        this._guid = "7773" + ("0000000000000000" + new Date().getTime().toString(16)).substr(-16) + ("000000000000" + parseInt(Math.random() * 1000000000).toString(16)).substr(-12)
        if (typeof opt === 'string')
            this._roomid = opt
        else if (typeof opt === 'object') {
            this._roomid = opt.roomid
            this.set_proxy(opt.proxy)
        }
    }

    set_proxy(proxy) {
        const proxy_obj = url.parse(proxy)
        this._agent = new socks_agent(proxy)
        this._proxy_opt = {
            timeout: timeout,
            command: 'connect',
            destination: { host: danmu_addr, port: danmu_port },
            proxy: { ipaddress: proxy_obj.hostname, port: parseInt(proxy_obj.port), type: 5 },
        }
        if (proxy_obj.auth) {
            const auth = proxy_obj.auth.split(':')
            this._proxy_opt.proxy.userId = auth[0]
            this._proxy_opt.proxy.password = auth[1]
        }
    }

    async _get_chat_info() {
        let time = Math.round(new Date().getTime() / 1000)
        let sign = md5(`uzY@H/C!N^G9K:EY${this._guid}v3${time}`)
        try {
            return await r({
                url: `https://online.panda.tv/dispatch?guid=${this._guid}&plat=pc%5Fweb&time=${time}&xid=${this._roomid}&sign=${sign}&cluster=v3`,
                agent: this._agent
            })
        } catch (e) { }
    }

    async _get_host_info() {
        try {
            let body = await r({
                url: `http://m.api.xingyan.panda.tv/room/baseinfo?xid=${this._roomid}`,
                agent: this._agent
            })
            return body.data
        } catch (e) { }
    }

    async _get_gift_info() {
        try {
            let gift_info = {}
            let body = await r({
                url: `https://gift.xingyan.panda.tv/gifts?__plat=pc_web&hostid=${this._hostid}&__version=1.11.7&_=${new Date().getTime()}`,
                agent: this._agent
            })
            body.data.forEach(g => {
                gift_info[g.id] = { name: g.name, price: g.price }
            })
            return gift_info
        } catch (e) { }
    }

    async _fresh_gift_info() {
        let gift_info = await this._get_gift_info()
        if (!gift_info) return this.emit('error', new Error('Fail to get gift info'))
        this._gift_info = gift_info
    }

    async start() {
        if (this._starting) return
        this._starting = true
        this._reconnect = true
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
        await this._fresh_gift_info()
        if (!this._gift_info) return this.emit('close')
        this._fresh_gift_info_timer = setInterval(this._fresh_gift_info.bind(this), fresh_gift_interval)
        this._start_tcp()
    }

    async _start_tcp() {
        const port = parseInt(this._chat_info.port)
        const addr = this._chat_info.addr
        if (this._proxy_opt) {
            try {
                this._proxy_opt.destination.host = addr
                this._proxy_opt.destination.port = port
                const info = await socks.createConnection(this._proxy_opt)
                this._client = info.socket
                this._on_connect()
            } catch (e) {
                this.emit('error', e)
            }
        } else {
            this._client = new net.Socket()
            this._client.connect(port, addr)
            this._client.on('connect', this._on_connect.bind(this))
        }

        this._client.on('error', err => {
            this.emit('error', err)
        })
        this._client.on('close', async () => {
            this._stop()
            this.emit('close')
            await delay(close_delay)
            this._reconnect && this.start()
        })
        this._client.on('data', this._on_data.bind(this))
    }

    _on_connect() {
        this._bind_user()
        this.emit('connect')
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

    _build_chat(msg) {
        return {
            type: 'chat',
            time: new Date().getTime(),
            from: {
                name: msg.from.nick,
                rid: msg.from.rid + '',
                level: msg.from.level_now,
                plat: msg.plat
            },
            id: md5(JSON.stringify(msg)),
            content: msg.data.text
        }
    }

    _build_online(msg) {
        return {
            type: 'online',
            time: new Date().getTime(),
            count: parseInt(msg.personnum)
        }
    }

    _build_star(msg) {
        return {
            type: 'starval',
            time: new Date().getTime(),
            count: parseInt(msg.starval)
        }
    }

    _build_gift(msg) {
        let gift = this._gift_info[msg.data.gift_id] || { price: 0, name: msg.data.gift_name }
        let price = gift.price
        let count = parseInt(msg.data.count)
        return {
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
            earn: price * count * 0.1,
            count: count
        }
    }

    _build_zhuzi(msg) {
        let count_array = msg.data.text.match(/(\d+)/)
        let count = parseInt(count_array[1])
        return {
            type: 'zhuzi',
            time: new Date().getTime(),
            name: '竹子',
            from: {
                name: msg.from.nick,
                rid: msg.from.rid + '',
                level: msg.from.level_now
            },
            id: md5(JSON.stringify(msg)),
            count: count
        }
    }

    _format_msg(msg) {
        try {
            msg = JSON.parse(msg)
        } catch (e) { }
        let msg_obj
        if (msg.type === 'chat' && msg.to == this._roomid) {
            msg_obj = this._build_chat(msg)
            this.emit('message', msg_obj)
        } else if (msg.personnum && msg.xid == this._roomid) {
            msg_obj = this._build_online(msg)
            this.emit('message', msg_obj)
        } else if (msg.starval && msg.xid == this._roomid) {
            msg_obj = this._build_star(msg)
            this.emit('message', msg_obj)
        } else if (msg.type === 'gift' && msg.to == this._roomid) {
            msg_obj = this._build_gift(msg)
            this.emit('message', msg_obj)
        } else if (msg.type === "bamboo" && msg.to == this._roomid) {
            msg_obj = this._build_zhuzi(msg)
            this.emit('message', msg_obj)
        }
    }

    _stop() {
        this._starting = false
        clearInterval(this._fresh_gift_info_timer)
        try { this._client.destroy() } catch (e) { }
    }

    stop() {
        this._reconnect = false
        this.removeAllListeners()
        this._stop()
    }
}

module.exports = xingyan_danmu