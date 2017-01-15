const root = typeof window === 'undefined' ? global : window;

function SynchronousUnsubscription() { throw SynchronousUnsubscription; }

function noop() { }

function obs(fn) { return new Observable(fn); }

function catchAll(fn, ...args) { try { return fn(...args); } catch(e) { /* ignore */ }}

export class Scheduler {
    schedule(fn) {
        throw new Error('Not implemented');
    }

    scheduleFuture() {
        throw new Error('Not implemented');
    }
}

Scheduler.immediate = new class ImmediateScheduler extends Scheduler {
    schedule(fn) {
        fn();
        return noop;
    }
};

Scheduler.currentThread = new class CurrentThreadScheduler extends Scheduler {
    schedule(fn) {
        let {q}=this;
        if(q)
            q.push(fn);
        else {
            q=this.q=[fn];
            while(q.length>0)
                q.shift()();
            this.q=null;
        }
        return ()=>{const idx=q.indexOf(); if(idx>=0) q.splice(idx,1);};
    }
};

Scheduler.default = new class DefaultScheduler extends Scheduler {
    schedule(fn) {
        const t=root.setTimeout(fn,0);
        return ()=>root.clearTimeout(t);
    }

    scheduleFuture(fn, delay) {
        delay = Math.max(0, typeof delay === 'number' ? delay : delay - Date.now());
        const t=root.setTimeout(fn, delay);
        return ()=>root.clearTimeout(t);
    }

    schedulePeriodic(fn, interval, delay) {
        interval = Math.max(0, interval);
        delay = Math.max(0, typeof delay === 'number' ? delay : delay - Date.now());
        if(delay) {
            let i;
            const t = this.scheduleFuture(()=>i=this.schedulePeriodic(fn,interval), delay);
            return ()=>{t();i && i();};
        } else {
            const i = root.setInterval(fn, interval);
            return ()=>root.clearInterval(i);
        }
    }
};

export class Observable {
    static empty() { return obs((n,e,c)=>c()); }

    static of(...args) {
        return this.from(args);
    }

    static from(x) {
        if(typeof x[Symbol.iterator] === 'function') {
            return obs((n,e,c)=>{
                for(const y of x) {
                    n(y);
                }
                c();
            })
        } else if(x instanceof Observable) {
            return x;
        } else if(x instanceof Promise) {
            return obs((n,e,c)=>{
                let cancelled=false;
                x.then(y=>{if(!cancelled){n(y);c();}}, e);
                return ()=>cancelled=true;
            });
        } else if(typeof x === 'function') {
            return this.from(x());
        }
    }

    static range(start, len) {
        if(typeof len !== 'number')
            len=Infinity;
        return this.from(function*() {
            const end=start+len;
            for(let i=start; i<end; ++i) yield i;
        });
    }

    static interval(intv) {
        return obs((n,e,c)=>{
            let i=0;
            return Scheduler.default.schedulePeriodic(()=>n(i++), intv);
        });
    }

    constructor(_subFn) {
        this._subscribe = _subFn;
    }

    _subscribe() { throw new Error('Not implemented'); }

    subscribe(n=noop,e=noop,c=noop) {
        const n2=x=>{try{return n(x);}catch(e){err(e);}};
        const e2=x=>{try{e(x);unsubscribe();}catch(e){err(e);}};
        const c2=()=>{try{c();unsubscribe();}catch(e){err(e);}};
        let unsubscribe = SynchronousUnsubscription;
        let res=noop;

        try {
            res=this._subscribe(n2,e2,c2)||noop;
        } catch(e) {
            if(e===SynchronousUnsubscription) {
                realUnsubscribe();
            } else {
                throw e;
            }
        }

        unsubscribe = realUnsubscribe;

        return {unsubscribe};

        function err(e) { unsubscribe(); throw e; }
        function realUnsubscribe() { n=e=c=noop; try{res();}catch(e){/*ignore*/}finally{res=noop;} }
    }

    _intercept(nfn) { return obs((n,e,c)=>this._subscribe(nfn(n,e,c),e,c)); }

    map(fn) { return this._intercept(n=>x=>n(fn(x))); }
    filter(fn) { return this._intercept(n=>x=>fn(x)&&n(x)); }
    take(num) { return num>=0 ? this._intercept((n,e,c)=>{let i=num; return x=>{n(x);if(--i<=0) c();}}) : Observable.empty(); }
    drop(num) { return num>=0 ? this._intercept((n,e,c)=>{let i=num; return x=>{if(i>0) i--; else n(x);}}) : this; }
    merge(num) {
        return obs((n,e,c)=>{
            let done=false;
            let active=0;
            const q=[];
            const resources = [];

            function pump() {
                while(active<num && q.length>0) {
                    const o=Observable.from(q.shift());
                    let sync=false;
                    try {
                        ++active;
                        const res=o.subscribe(n, e, ()=>{
                            --active;
                            if(!sync) {
                                sync=true;
                            } else {
                                const idx=resources.indexOf(res);
                                if(idx >= 0)
                                    resources.splice(idx,1);
                                pump();
                            }
                        })||noop;

                        if(!sync) {
                            sync=true;
                            resources.push(res);
                        }
                    } catch(err) {
                        e(err);
                    }
                }
                if(active===0 && q.length===0 && done)
                    c();
            }

            resources.push(this._subscribe(
                x=>{q.push(x);pump();},
                e,
                ()=>{done=true;pump();}
            ));

            return ()=>{
                done=true;
                active=0;
                q.length=0;
                resources.forEach(catchAll);
                resources.length=0;
            };
        });
    }

    mergeAll() {
        return this.merge(Infinity);
    }

    concat() {
        return this.merge(1)
    }

    flatMap(fn) {
        return this.map(fn).mergeAll();
    }

    concatMap(fn) {
        return this.map(fn).merge(1);
    }
}