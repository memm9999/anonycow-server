import {Session} from "./session.js";

const session = async (req, res, next) => {
    const session = new Session(req)

    if (await session.verify()) {
        res.cookie('session', await session.new())
    }

    Object.defineProperty(
        req,
        "session",
        {
            value: session
        }
    )

    next()
}

export default session;