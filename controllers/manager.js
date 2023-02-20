export const FRONTEND_USER_KEYS = ['id', 'name', 'username', 'avatar', 'balance', 'vcn', 'timerLastDuration', 'timerPreserved', 'fortuneItems', 'withdraw', 'ready']

export class SessionManager {
    constructor(prisma, io = undefined, session = undefined, socket = undefined) {
        this.prisma = prisma
        this.session = session
        this.socket = socket
        this.io = io
        this.ioEventHandler.bind(this)
    }

    static _processMapping = {
        PRIMARY: [
            "pts:modify",
            "pts:request",
            "pts:confirm",
            "pts:withdraw",
            "fortune:edit",
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

    static init = async (prisma) => {
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
            try {
                return props.reduce((a, e) => ({...a, [e]: o[e]}), {})
            } catch (e) {
                console.log(e)
            }
        };
    }

    static _broadcastUserEvents = (manager) => ({
        "user:get": {
            filter: (userObj) => {
                // console.log(`>>> The condition: ${userObj && manager.session?.userLoggedIn}`)
                // console.log(`>>> The timerLastDuration: ${userObj?.timerLastDuration}`)
                // console.log(`>>> The userLoggedIn: ${manager.session?.userLoggedIn}`)
                return (userObj && manager.session?.userLoggedIn) ? SessionManager._specifyKeys(FRONTEND_USER_KEYS)(userObj) : {}
            }
        },
        "admin:select": {
            filter: (userObj) => userObj ? SessionManager._specifyKeys(FRONTEND_USER_KEYS.concat(["spins"]))(userObj) : {}
        }
    })

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

    createData = async (model, data, include) => {
        return await model.create({
            data: data,
            include: include
        })
    }

    updateData = (model, id, dataObj, include) => new Promise(async (resolve) => {
        const data = await model.update({
            where: {
                id: id
            },
            data: dataObj,
            include: include
        })

        resolve(data)
    })

    updateInSession = (obj) => new Promise((resolve) => {
        for(const key in obj) {
            this.session[key] = obj[key]
        }

        this.session.reload(() => {
            this.session.save()
        })

        resolve(this.session)
    })

    getData = async (model, obj, include) => {
        // console.log(obj)
        try {
            return await model.findUnique({
                where: obj,
                include: include
            })
        } catch (e) {
            // console.log(e)
        }
    }

    createUser = (data, include) => {
        return this.createData(this.prisma.user, data, include)
    }

    getUser = (id, include) => {
        return this.getData(this.prisma.user, {
            id: id
        }, include)
    }

    getUserByUsername = (username, include) => {
        return this.getData(this.prisma.user, {
            username: username
        }, include)
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

            return await this.createData(this.prisma.process, dataObj)
        }

    }

    ioBroadcastUser = async (id = this.session?.userId, data=null, events = SessionManager._broadcastUserEvents(this)) => {

        // console.log(data)

        for (const event in events) {

            this.io.to(id || this.socket.id).emit(
                event,
                events[event].filter(
                    data ||
                    await this.getUser(
                        id, {
                            fortuneItems: true
                        }
                    )
                )
            )

        }

    }

    // ioBroadcastUser = async (id, light = false, events = {
    //     "user:get": {
    //         filter: (userObj) => SessionManager._specifyKeys(FRONTEND_USER_KEYS)(userObj)
    //             // this.session?.userLoggedIn ? SessionManager._specifyKeys(FRONTEND_USER_KEYS)(userObj) : {}
    //     },
    //     "admin:select": {
    //         filter: (userObj) => this.session?.selectedUser?.id === userObj?.id ? SessionManager._specifyKeys(FRONTEND_USER_KEYS.concat(["spins"]))(userObj) : {}
    //     }
    // }) => {
    //     // console.log(id)
    //
    //     if (id === SessionManager._initUserId) {
    //         this.io.to(this.socket.id).emit("user:get", {})
    //     } else {
    //         for (const event in events) {
    //
    //             this.io.to(id).emit(
    //                 event,
    //                 events[event].filter(
    //                     light ?
    //                         this.session?.user :
    //                         await this.getUser(
    //                             id, {
    //                                 fortuneItems: true
    //                             }
    //                         )
    //                 )
    //             )
    //
    //         }
    //     }
    // }

    // ioLightUpdateUser = (id, data, admin = false) => new Promise(async (resolve) => {
    //     const dataObj = data ?
    //         await this.updateData(this.prisma.user, id, data, {
    //             fortuneItems: true
    //         }) :
    //         this.session?.user
    //
    //     if (id && id !== SessionManager._initUserId) {
    //         if (this.session?.selectedUser) {
    //             await this.updateInSession(
    //                 "selectedUser",
    //                 dataObj
    //             )
    //         }
    //
    //         if (this.session?.user) {
    //             this.updateInSession(
    //                 "user",
    //                 dataObj
    //             ).then((session) => {
    //                 resolve(session)
    //             })
    //         }
    //     } else {
    //         resolve(this.session)
    //     }
    //
    //     await this.ioBroadcastUser(id, true, admin)
    // })

    ioUpdateUser = (id, data) => new Promise(async (resolve) => {
        await this.updateData(this.prisma.user, id, data, {
            fortuneItems: true
        }).then(
            (data) => {
                this.ioBroadcastUser(id, data)
                resolve(data)
            }
        )
    })

    // ioUpdateUser = (id = this.session?.user?.id || SessionManager._initUserId, data, light = false) => new Promise(async (resolve) => {
    //     const dataObj = data ?
    //         await this.updateData(this.prisma.user, id, data, {
    //             fortuneItems: true
    //         }) :
    //         light ?
    //             this.session?.user:
    //             await this.getData(this.prisma.user, {
    //                     id: id
    //                 }, {
    //                     fortuneItems: true
    //                 }
    //             )
    //
    //     if (id && id !== SessionManager._initUserId) {
    //         this.updateInSession(
    //             "user",
    //             dataObj
    //         ).then((session) => {
    //             resolve(session)
    //         })
    //     } else {
    //         resolve(this.session)
    //     }
    //
    //     await this.ioBroadcastUser(id, light)
    // })

    ioEventHandler = async function (action, handler, admin = false) {
        // return async () => await this.saveProcessRecord(action, handler())
        const params = Array(handler.length).fill(null).map((v, i) => "p" + i)

        const AsyncFunction = async function () {
        }.constructor;

        const _handler = new AsyncFunction(
            ...params,
            `
            const [[action, handler, admin], SessionManager, ...innerArgs] = arguments
            if(admin) {
                this.io.to(this.socket.id).emit('admin:get', this.session?.admin ? SessionManager._specifyKeys(['username'])(this.session?.admin) : {})
                if(this.session?.admin?.id) {
                    return this.saveProcessRecord(action, await handler(...innerArgs))
                }
            } else if(!admin) {
                return this.saveProcessRecord(action, await handler(...innerArgs))
            }
            `
        )

        return _handler.bind.bind(_handler)(this, arguments, SessionManager)
    }


    ioOn = async (action, handler) => {
        this.socket.on(action, await this.ioEventHandler(action, handler))
    }

    ioAdminOn = async (action, handler) => {
        this.socket.on(action, await this.ioEventHandler(action, handler, true))
    }

}