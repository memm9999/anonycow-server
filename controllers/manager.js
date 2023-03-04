import Queue from "bull";
import {Socket} from "socket.io";
import session, {Session} from "express-session";
import crypto from "crypto";

export const FRONTEND_USER_KEYS = ['id', 'name', 'username', 'avatar', 'balance', 'vcn', 'timerLastDuration', 'timerPreserved', 'fortuneItems', 'withdraw', 'ready', 'fortuneOrder', 'totalProcesses']

export class SessionManager {
    constructor(prisma, io = undefined, attachment) {
        this.prisma = prisma
        // this.session = session
        // this.sessionId = sessionId
        // this.socket = socket
        switch (true) {
            case attachment instanceof Socket:
                this.setSocket(attachment)
                break;

            case attachment instanceof Session:
                this.setSession(attachment)
                break;
        }
        // this.socketId = this.socket.id || socketId
        this.io = io
        // this._sessionEditQueue = new Queue('sessionEdit')
        // // console.log(this.sessionID)
        // console.log(this.sessionId)

        // try {
        //     console.log(">>> Registering process <<<")
        //     this._sessionEditQueue.process((job, done) => {
        //
        //         const obj = job.data.obj
        //         console.log(">>> triggered <<<")
        //
        //         // if(job.data.value) {
        //         //     this.session[job.data.key] = job.data.value
        //         // } else {
        //         //     delete this.session[job.data.key]
        //         // }
        //
        //         try {
        //             // this.session.reload(()=>{
        //             //     this.session[job.data.key] = job.data.value
        //             //     this.session.save()
        //             // })
        //             for(const key in obj) {
        //                 console.log(key, obj[key])
        //                 if(obj[key]) {
        //                     this.session[key] = obj[key]
        //                     // Object.defineProperty(
        //                     //     this.session,
        //                     //     key,
        //                     //     {
        //                     //         value: obj[key],
        //                     //         writable: true
        //                     //     }
        //                     // )
        //                 } else {
        //                     // try {
        //                     console.log(`>>> ${key} is deleted <<<`)
        //                     delete this.session[key]
        //                     // } catch (e) {}
        //                 }
        //             }
        //
        //             this.session.save()
        //
        //             // this.session.reload(()=>{
        //             //     this.session.save()
        //             // })
        //
        //             console.log(this.session)
        //
        //         } catch (e) {
        //             console.log(e)
        //         }
        //
        //         done()
        //     })
        // } catch (e) {}

        this.ioEventHandler.bind(this)
    }

    static _processMapping = {
        PRIMARY: [
            "pts:modify",
            "pts:request",
            "pts:confirm",
            "pts:withdraw",
            "fortune:edit",
            "fortune:add",
            "spins:modify",
            "timer:ready",
            "timer:set",
            "timer:end",
            "timer:start",
            "timer:pause"
        ],
        SECONDARY: [
            "user:create",
            "user:login",
            "user:get",
            "vcn:add",
            "vcn:edit",
            "vcn:verify",
            "vcn:save",
            "fortune:spin",
            "fortune:confirm",
            "fortune:prizes",
            "activities:list",
            "activities:count",
            "client:log",
            "admin:get",
            "admin:select"
        ]
    }

    static _processMappingGenerated = Object.fromEntries(
        Object.entries(
            SessionManager._processMapping
        ).map(
            ([k, v]) => {
                return v.map(i => [i, k])
            }
        ).flat()
    )

    static _initUserId = "anonymous"

    static init = async (prisma, app, io) => {

        app.post('/api/pin', async (req, res) => {
            const manager = new SessionManager(prisma, io, req.session)

            const id = req.body?.id

            if(id) {
                const pin = await manager.getData(
                    manager.prisma.pin,
                    {
                        id: id
                    }
                )

                const obj = pin?.data?.obj
                const redirect = pin?.data?.redirect

                if(pin?.id) {
                    for(const key in obj) {
                        if(obj[key]) {
                            req.session[key] = obj[key]
                        } else {
                            delete req.session[key]
                        }
                    }
                }

                // req.session.reload((err)=>{
                //     console.log(err)
                //
                //     // req.session.save()
                // })

                // req.session.reload((err)=>{
                //
                //     if(pin?.id) {
                //         for(const key in obj) {
                //             if(obj[key]) {
                //                 req.session[key] = obj[key]
                //             } else {
                //                 delete req.session[key]
                //             }
                //         }
                //     }
                //
                //     req.session.save()
                //     console.log(err)
                // })

                // req.session.reload((err)=>{
                //     console.log(err)
                //     console.log("Hello")
                // })

                // req.session.save()
                // req.session.reload(()=>{})

                // req.session.reload(()=>{
                //     req.session.save()
                // })

                if(redirect) {
                    res.json({
                        redirect: redirect
                    })
                } else {
                    res.json({
                        redirect: null
                    })
                }

            } else {
                res.json({
                    redirect: null
                })
            }


        })

        if (!await prisma.user.findUnique({
            where: {
                id: SessionManager._initUserId
            }
        })) {
            await prisma.user.create({
                data: {
                    id: SessionManager._initUserId,
                    name: "",
                    username: "",
                    avatar: ""
                }
            })
        }
    }

    static _specifyKeys = (props) => {
        return o => {
            if(o) {
                try {
                    return props.reduce((a, e) => ({...a, [e]: o[e]}), {})
                } catch (e) {
                    console.log(e)
                }
            } else {
                return {}
            }
        };
    }

    static _broadcastUserEvents = {
        "user:get": {
            filter: SessionManager._specifyKeys(FRONTEND_USER_KEYS)
        },
        "admin:select": {
            filter: SessionManager._specifyKeys(FRONTEND_USER_KEYS.concat(["spins"]))
        },
        "activities:count": {
            filter: async (userObj, manager) => {
                const _data = await manager.prisma.process.count({
                    where: {
                        userId: {
                            equals: userObj?.id
                        }
                    }
                })

                return _data
            }
        }
    }

    setIO = (io) => {
        this.io = io
    }

    setSocket = (socket) => {
        this.socket = socket
        this.setSession(socket.request.session)
    }

    setSession = (session) => {
        this.session = session
    }

    /*
    * CRUD operations
    * */

    createData = (model, data, include) => {
        return model.create({
            data: data,
            include: include
        })
    }

    updateData = (model, id, dataObj, include) => {
        return model.update({
            where: {
                id: id
            },
            data: dataObj,
            include: include
        })
    }

    getData = (model, obj, include) => {
        // console.log(obj)
        return model.findUnique({
            where: obj,
            include: include
        })
    }

    /*
    * Session-related operations
    * */

    updateInSession = (obj, redirect=null, via='io') => new Promise(async (resolve) => {
        const pinData = {
            obj: obj,
            redirect: redirect
        }

        const pin = await this.createData(
            this.prisma.pin,
            {
                id: crypto.createHash('sha1').update(JSON.stringify(pinData) + crypto.randomBytes(32).toString('hex')).digest('hex'),
                data: pinData
            }
        )

        switch (via) {
            case 'io':
                this.io.to(this.socket?.id).emit("pin", pin?.id)
                break;

            default:
                if(via?.redirect) {
                    via?.redirect?.(`/pin/${pin?.id}`)
                }
                break;
        }

        resolve(pin?.id)
    })

    // updateInSession = (obj) => {
    //     for(const key in obj) {
    //         if(obj[key]) {
    //             this.session[key] = obj[key]
    //         } else {
    //             delete this.session[key]
    //         }
    //     }
    //
    //     this.session.reload(() => {
    //         this.session.save()
    //     })
    //
    //     return Promise.resolve(this.session)
    // }

    /*
    * User-related operations
    * */

    createUser = (data, include={
        fortuneItems: true,
        // _count: {
        //     select: {
        //         processes: true
        //     }
        // }
    }) => {
        return this.createData(this.prisma.user, data, include)
    }

    getUser = (id, include={
        fortuneItems: true,
        // _count: {
        //     select: {
        //         processes: true
        //     }
        // }
    }) => {
        if(id) {
            return this.getData(this.prisma.user, {
                id: id
            }, include)
        }

        return null
    }

    updateUser = (id, data, include={
        fortuneItems: true,
        // _count: {
        //     select: {
        //         processes: true
        //     }
        // }
    }) => {
        if(id && data) {
            return this.updateData(this.prisma.user, id, data, include)
        }

        return null
    }

    getUserByUsername = (username, include={
        fortuneItems: true,
        // _count: {
        //     select: {
        //         processes: true
        //     }
        // }
    }) => {
        if(username) {
            return this.getData(this.prisma.user, {
                username: username
            }, include)
        }

        return null
    }

    /*
    * SocketIO-related operations
    * */

    ioBroadcastUser = async (id = this.session?.userId, data=null, events = SessionManager._broadcastUserEvents) => {

        // const processesCount = await this.prisma.process.count({
        //     where: {
        //         userId: {
        //             equals: id
        //         }
        //     }
        // })

        // console.log('>>> Broadcasting:')
        let _data;

        if(data) {
            _data = data
        } else {
            _data = await this.getUser(id)
        }

        // _data = {
        //     ..._data,
        //     // totalProcesses: _data?._count?.processes
        //     // totalProcesses: processesCount
        // }

        for (const event in events) {

            // console.log(event)
            // console.log(_data)

            this.io.to(id || this.socket.id).emit(
                event,
                events[event].filter(
                    _data,
                    this
                )
            )

        }

        return Promise.resolve(_data)

    }

    // ioBroadcastProcessesCount = async (id = this.session?.selectedUserId || this.session?.userId) => {
    //     const _data = await this.prisma.process.count({
    //         where: {
    //             userId: {
    //                 equals: id
    //             }
    //         }
    //     })
    //
    //     if(id) {
    //         this.io.to(id).emit(
    //             "activities:count",
    //             _data
    //         )
    //     }
    //
    //     return Promise.resolve(_data)
    // }

    ioUpdateUser = async (id, data, events=SessionManager._broadcastUserEvents) => {
        const _data = await this.updateUser(id, data)
        // this.ioBroadcastProcessesCount(id)
        return this.ioBroadcastUser(id, _data, events)
    }

    saveProcessRecord = async (
        action,
        optArray = [{
            user: SessionManager._initUserId
        }]
    ) => {

        if (optArray.length) {
            const dataObj = {
                type: action,
                class: SessionManager._processMappingGenerated[action],
            }

            const [connects, data] = optArray

            if (data) {
                dataObj.data = data
            }

            if (Object.keys(connects).length) {
                for (const connect in connects) {
                    dataObj[connect] = {
                        connect: {
                            id: connect === 'user' && !connects[connect] ? SessionManager._initUserId : connects[connect]
                        }
                    }
                }
            }

            const _data = await this.createData(this.prisma.process, dataObj)

            return _data
        }

    }

    ioEventHandler = function (action, handler, admin = false) {
        let _handler;

        // this.session.reload((err)=>{
        //     console.log(err)
        //     console.log("Hello")
        // })

        if(handler.constructor.name === 'AsyncFunction') {
            _handler = async function () {
                /*
                * Returns: Process object for a later usage
                * */

                if(admin) {
                    this.io.to(this.socket.id).emit('admin:get', this.session?.admin ? SessionManager._specifyKeys(['username'])(this.session?.admin) : {})
                    if(!this.session?.admin?.id) {
                        return undefined
                    }
                }

                return this.saveProcessRecord(action, await handler(...arguments))
            }
        } else {
            _handler = function () {
                /*
                * Returns: Process object for a later usage
                * */

                if(admin) {
                    this.io.to(this.socket.id).emit('admin:get', this.session?.admin ? SessionManager._specifyKeys(['username'])(this.session?.admin) : {})
                    if(!this.session?.admin?.id) {
                        return undefined
                    }
                }

                return this.saveProcessRecord(action, handler(...arguments))
            }
        }

        return _handler.bind.bind(_handler)(this)
    }


    ioOn = (action, handler) => {
        this.socket.on(action, this.ioEventHandler(action, handler))
    }

    ioAdminOn = (action, handler) => {
        this.socket.on(action, this.ioEventHandler(action, handler, true))
    }

}