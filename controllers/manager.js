import {Socket} from "socket.io";
import {Session} from "./session/session.js";
import crypto from "crypto";
import cookieParser from "cookie-parser"
import session from "./session/middleware.js";
import { serialize } from "cookie";

export const FRONTEND_USER_KEYS = ['id', 'name', 'username', 'avatar', 'balance', 'vcn', 'timerLastDuration', 'timerPreserved', 'fortuneItems', 'withdraw', 'ready', 'fortuneOrder', 'totalProcesses']

export class SessionManager {
    constructor(prisma, io = undefined, attachment) {
        this.prisma = prisma
        switch (true) {
            case attachment instanceof Socket:
                this.setSocket(attachment)
                break;

            case attachment instanceof Session:
                this.setSession(attachment)
                break;
        }
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
            "chat:list",
            "chat:scroll",
            "chat:messages",
            "chat:scroll-messages",
            "activities:refresh",
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

    static wrap = middleware => (socket, next) => middleware(socket.request, {}, next);

    static init = async (prisma, app, io) => {

        app.use(cookieParser())
        app.use(session)
        io.use(SessionManager.wrap(cookieParser()))
        // io.use((socket, next) => session(socket, {}, next))

        io.engine.on("initial_headers", (headers, req) => {
            // console.log(`>>> session.id from initial_headers >>> ${req.session.id} >>>`)
            headers["set-cookie"] = serialize(
                "session",
                req.session.id,
                {
                    path: '/'
                }
            );
        });

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

    static ioAllowRequestConfig = async (req, callback) => {
        const session = new Session(req, true)

        Object.defineProperty(
            req,
            "session",
            {
                value: session
            }
        )

        // console.log(`>>> session.id from allowRequest >>> ${req.session.id} >>>`)

        if (await session.verify()) {
            req.session.id = await session.new()
        }

        callback(null, true);
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
    * User-related operations
    * */

    createUser = (data, include={
        fortuneItems: true
    }) => {
        return this.createData(this.prisma.user, data, include)
    }

    getUser = (id, include={
        fortuneItems: true
    }) => {
        if(id) {
            return this.getData(this.prisma.user, {
                id: id
            }, include)
        }

        return null
    }

    updateUser = (id, data, include={
        fortuneItems: true
    }) => {
        if(id && data) {
            return this.updateData(this.prisma.user, id, data, include)
        }

        return null
    }

    getUserByUsername = (username, include={
        fortuneItems: true
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

    ioBroadcastUser = async (id = null, data=null, events = SessionManager._broadcastUserEvents) => {

        if(!id) {
            id = await this.session.get()?.userId
        }

        let _data;

        if(data) {
            _data = data
        } else {
            _data = await this.getUser(id)
        }

        for (const event in events) {

            this.io.to(id || this.socket.id).emit(
                event,
                events[event].filter(
                    _data
                )
            )

        }

        return Promise.resolve(_data)

    }

    ioBroadcastProcessesRefresh = async (id) => {

        if(id) {
            this.io.to(id).emit(
                "activities:refresh",
                crypto.randomBytes(32).toString('hex')
            )
        }

        return Promise.resolve()
    }

    ioUpdateUser = async (id, data, events=SessionManager._broadcastUserEvents, broadcastProcesses=true) => {
        const _data = await this.updateUser(id, data)
        const _ioBroadcastUserPromise = this.ioBroadcastUser(id, _data, events)
        if (broadcastProcesses) {
            await this.ioBroadcastProcessesRefresh(id)
        }
        return _ioBroadcastUserPromise
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

    ioEventHandler = function (action, handler, admin = false, broadcastProcesses = true) {
        let _handler;

        _handler = async function () {
            /*
            * Returns: Process object for a later usage
            * */
            const session = await this.session.get()

            // console.log(session)

            if(admin) {
                this.io.to(this.socket.id).emit('admin:get', session?.admin ? SessionManager._specifyKeys(['username'])(session?.admin) : {})
                if(!session?.admin?.id) {
                    return undefined
                }
            }

            const _process = await handler(session, ...arguments)

            if(session?.userId && broadcastProcesses) {
                await this.ioBroadcastProcessesRefresh(session?.userId)
            }

            return await this.saveProcessRecord(action, _process)
        }

        return _handler.bind.bind(_handler)(this)
    }


    ioOn = (action, handler) => {
        this.socket.on(action, this.ioEventHandler(action, handler))
    }

    ioAdminOn = (action, handler, broadcastProcesses) => {
        this.socket.on(action, this.ioEventHandler(action, handler, true, broadcastProcesses))
    }

}