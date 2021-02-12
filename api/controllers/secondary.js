'use strict';

const express = require('express');
const router = express.Router();
const jwt = require('express-jwt');
const axios = require('axios');
const async = require('async');
const path = require('path');
const fs = require('fs');

const config = require('../config');
const db = require('../models');
const common = require('../common');

/**
 * @apiGroup Secondary
 *                              List secondary output list. This is a public interface (for now) as it only contains the metadata, 
 *                              and user must know the project id to access it. But it would be nice to restrict this to the 
 *                              ipython notebook running for the group. maybe I can issue a special token?
 * @apiSuccess {Object}         List of secondary outputs
 */
router.get('/list/:projectid', /*jwt({secret: config.express.pubkey}),*/ async (req, res, next)=>{
    try {
        let project = db.Projects.findById(req.params.projectid);
        if(!project) return res.status(404).end();

        /*
        if(!common.isadmin(req.user, project) && !common.ismember(req.user, project)) {
            return res.status(401).end("you are not an administartor nor member of this project");
        } 
        */

        console.log("project group", project.group_id);
        const _res = await axios.get(config.amaretti.api+'/task', {
            params: {
                select: 'config instance_id',
                find: JSON.stringify({
                    'finish_date': {$exists: true},
                    'service': 'brainlife/app-archive-secondary',
                    '_group_id': project.group_id,
                }),
                limit: 20000, //TODO.. how scalable is this!?
                sort: 'create_date',
            },
            //headers: { authorization: req.headers.authorization },
            headers: { authorization: "Bearer "+config.warehouse.jwt },
        });
        console.dir(_res);

        //let validator_ids = _res.data.tasks.map(task=>task.config.validator_task._id);
        let objects = [];
        
        //merge all output requests into a single list
        _res.data.tasks.forEach(task=>{
            if(!task.config.requests) return; //old format?
            task.config.requests.forEach(request=>{
                if(!request.datatype) return; //should only happen on dev
                
                //pull information out of request and store things that users care
                objects.push({
                    path: request.instance_id+"/"+request.task_id+"/"+request.subdir,

                    task_id: request.task_id,
                    //instance_id: request.instance_id,
                    //subdir: request.subdir,

                    datatype: request.datatype,
                    app: request.app,
                    output: request.output,
                    finish_date: request.finish_date,
                    /*
                    datatype: {
                        id: request.datatype._id,
                        name: request.datatype.name,
                        desc: request.datatype.desc,
                        files: request.datatype.files,
                    },

                    desc: request.output.desc,
                    datatype_tags: request.output.datatype_tags,
                    tags: request.output.tags,
                    meta: request.output.meta,
                    */
                })
            });
        });

        res.json(objects);

    } catch (err) {
        next(err);
    }
});

/**
 * @apiGroup Secondary
 * @api {get} /secondary/:task_id/:path
 *                          Download secondary content for a given dtv task / and path
 * @apiHeader {String} authorization 
 *                          A valid JWT token "Bearer: xxxxx"
 * @apiSuccess {Object}     Directory structure of secondary content
 */
router.get('/:task_id/*', jwt({
    //similar to dataset/download
    secret: config.express.pubkey,
    //credentialsRequired: false,
    getToken: function(req) { 
        //load token from req.headers as well as query.at
        if(req.query.at) return req.query.at; 
        if(req.headers.authorization) {
            var auth_head = req.headers.authorization;
            if(auth_head.indexOf("Bearer") === 0) return auth_head.substr(7);
        }
        return null;
    }
}), (req, res, next)=>{
    const task_id = req.params.task_id;
    const p = req.query.p || req.params[0];

    //{ headers: { Authorization: "Bearer "+req.user.jwt||req.query.at } }
    axios.get(config.amaretti.api+"/task/"+task_id).then(taskres=>{
        if(taskres.status != 200) return next("failed to load task "+task_id);
        const task = taskres.data;
        const gids = req.user.gids||[];
        if(task.user_id != req.user.sub && !~gids.indexOf(task._group_id)) return next("you don't own this task or member of a group "+task._group_id);

        //ok looks good.. 
        const follow_task_id = task.deps_config[0].task;
        const prefix = config.groupanalysis.secondaryDir+"/"+task._group_id+"/"+task.instance_id+"/"+follow_task_id;

        //make sure path looks safe
        const clean_p = path.resolve(prefix+"/"+p);
        console.debug("clean_p", clean_p);
        console.debug("prefix", prefix);
        if(!clean_p.startsWith(prefix)) return next("invalid path");

        //const readstream = fs.createReadStream(clean_p);
        config.groupanalysis.getSecondaryDownloadStream(clean_p, (err, readstream)=>{
            if(err) return next(err);

            readstream.pipe(res);   
            readstream.on('error', err=>{
                console.error("failed to pipe", err);
                next(err); 
            });
            res.on('finish', ()=>{
                common.publish("secondary.download."+req.user.sub+"."+task._group_id+"."+task._id, {headers: req.headers, path: clean_p});
            });
        });
    }).catch(err=>{
        next(err);
    });
});

/**
 * @apiGroup Secondary
 * @api {put} /secondary/launchga   Launch Group Analysis Container
 *                              
 * @apiParam {String} instance_id  Instance to launch the group analysis 
 * @apiParam {String} container     Name of the container to submit
 * @apiParam {String} tag           Tag of the container
 * @apiParam {String} [name]        Name for this analysis
 * @apiParam {String} [desc]        Description for this analysis
 * @apiParam {Object} [config]      Configuration to send to the launcher
 * @apiParam {String} app           App to initialize inside the container (like soichih/ga-test)
 *
 * @apiHeader {String} authorization 
 *                                  A valid JWT token "Bearer: xxxxx"
 *
 * @apiSuccess {Object}             Submitted launcher task
 */
router.post('/launchga', jwt({secret: config.express.pubkey}), (req, res, next)=>{
    if(!req.body.instance_id) return next("instance_id is not set");
    if(!req.body.container) return next("container name is not set");
    if(!req.body.tag) return next("container tag is not set");

    let task_config = {};
    if(req.body.config) Object.assign(task_config, req.body.config);

    let project = null;
    let instance = null;
    let jwt = null;
    let task = null;

    async.series([

        //access control instance by querying for it
        next=>{
            axios.get(config.amaretti.api+"/instance", {
                params: {
                    find: JSON.stringify({_id: req.body.instance_id}),
                },
                headers: { authorization: req.headers.authorization, },
            }).then(_res=>{
                if(_res.data.instances.length != 1) return next("no such instance?");
                instance = _res.data.instances[0];
                next();
            }).catch(next);
        },

        //give the user jwt extra access to gid used to archive
        next=>{
            axios.get(config.auth.api+"/jwt/"+req.user.sub, {
                params: {
                    claim: JSON.stringify({gids: [config.groupanalysis.gid]}),
                },
                headers: { authorization: "Bearer "+ config.warehouse.jwt }
            }).then(_res=>{
                jwt = _res.data.jwt;
                next();
            }).catch(next);
        },

        //load project
        next=>{
            db.Projects.findOne({group_id: instance.group_id}, (err, _project)=>{
                if(err) return next(err);
                if(!_project) return next("can't find project with group_id:"+instance.group_id);
                project = _project;
                task_config.project = _project;
                next();
            });
        },

        //submit the launcher
        next=>{
            task_config.container = req.body.container+":"+req.body.tag;
            task_config.group = instance.group_id;
            task_config.app = req.body.app; //like.. soichih/ga-test

            axios.post(config.amaretti.api+"/task", {
                name: req.body.name,
                desc: req.body.desc,
                service : "brainlife/ga-launcher",
                service_branch: "master", //TODO
                instance_id : instance._id,
                max_runtime: 24*1000*3600, //24 hour should be enough?
                config: task_config,
            }, {
                headers: { authorization: "Bearer "+jwt, }
            }).then(_res=>{
                task = _res.data.task;
                next();
            }).catch(next);
        },

    ], err=>{
        if(err) return next(err);
        res.json(task);
    });
});

module.exports = router;


