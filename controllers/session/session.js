import {Client} from 'redis-om';
import {parse} from "cookie";
import {sessionSchema} from "./scheme.js";
// const client = new Client()
// await client.open()
const client = new Client()
await client.open(process.env.REDIS_STACK_URL)

const sessionRepository = client.fetchRepository(sessionSchema)

export class Session {

    static client = client
    constructor(req, io=false) {
        this.id = io? parse(req[Object.getOwnPropertySymbols(req)[1]]?.cookie || "")?.session : req.cookies?.session
        // this.id = req.cookies?.session
        // this.req = req

        this.verify().then(r => {})
        //
        // this.verify.bind(this)
        // this.get.bind(this)
        // this.set.bind(this)
    }

    verify = async () => !this.id || !((await sessionRepository.fetch(this.id)).entityFields?.data?._value)

    new = async () => {
        const data = await sessionRepository.createAndSave({
            data: JSON.stringify({})
        })

        return data.entityId
    }

    _get = async () => await sessionRepository.fetch(this.id)

    get = async () => {
        const data = await this._get()
        return JSON.parse(data.toJSON()?.data)
    }

    set = async (key, value) => {
        const data = await this._get()

        data.data = JSON.stringify({
            ...JSON.parse(data.toJSON()?.data),
            ...Object.fromEntries([[key, value]])
        })

        await sessionRepository.save(data)

        return this.get()
    }

    setBulk = async (obj) => {
        const data = await this._get()

        const _obj = JSON.parse(data.toJSON()?.data)

        for(const key in obj) {
            if(obj[key]) {
                _obj[key] = obj[key]
            } else {
                delete _obj[key]
            }
        }

        data.data = JSON.stringify(_obj)

        await sessionRepository.save(data)

        return this.get()
    }
}