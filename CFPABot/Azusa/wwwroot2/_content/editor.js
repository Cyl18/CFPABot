// https://blog.expo.io/building-a-code-editor-with-monaco-f84b3a06deaf



// ReSharper disable StringLiteralWrongQuotes

let editor = {} ;
let model = {} ;

function set_editor_content(id, s, ct) {
    require.config({
        paths: {
            'vs': 'https://cdn.jsdelivr.net/npm/monaco-editor@0.41.0/min/vs'
        }
    });
    require(['vs/editor/editor.main'], function () {
        
        model[id] = monaco.editor.createModel(s, ct);
        editor[id].setModel(model[id]);

    });
}

function get_editor_selection(id) {
    return JSON.stringify(editor[id].getSelection());
}

function get_editor_content(id) {
    return model[id].getValue();
}

function set_location(id, line){
    editor[id].setPosition({column: 1, lineNumber: line});
}

function load_editor(id, readonly) {
    require.config({
        paths: {
            'vs': 'https://cdn.jsdelivr.net/npm/monaco-editor@0.41.0/min/vs'
        }
    });
    

    let currentFile = '/index.php';



    // localStorage.removeItem('files');

    
    require(['vs/editor/editor.main'], function () {

        monaco.languages.typescript.javascriptDefaults.setEagerModelSync(true);
        monaco.languages.typescript.javascriptDefaults.setCompilerOptions({
            allowNonTsExtensions: true
        });


        editor[id] = monaco.editor.create(document.getElementById('container-'+id), {
            automaticLayout: true,
            scrollBeyondLastLine: false,
            model: null,
            readOnly: readonly,
            theme: "vs-dark",
            // roundedSelection: false,
        });
        

    });
}

function load_diff_editor(id, readonly) {
    require.config({
        paths: {
            'vs': 'https://cdn.jsdelivr.net/npm/monaco-editor@0.41.0/min/vs'
        }
    });


    let currentFile = '/index.php';



    // localStorage.removeItem('files');


    require(['vs/editor/editor.main'], function () {

        monaco.languages.typescript.javascriptDefaults.setEagerModelSync(true);
        monaco.languages.typescript.javascriptDefaults.setCompilerOptions({
            allowNonTsExtensions: true
        });


        editor[id] = monaco.editor.createDiffEditor(document.getElementById('container-' + id), {
            automaticLayout: true,
            scrollBeyondLastLine: false,
            model: null,
            readOnly: readonly,
            theme: "vs-dark",
            diffWordWrap: "on",
            wordWrap: "on"
            // roundedSelection: false,
        });

    });
}


function set_diff_content(id, s1, s2, ct) {
    require.config({
        paths: {
            'vs': 'https://cdn.jsdelivr.net/npm/monaco-editor@0.41.0/min/vs'
        }
    });
    require(['vs/editor/editor.main'], function () {

        model[id] = {
            original: monaco.editor.createModel(s1, ct),
            modified: monaco.editor.createModel(s2, ct)
        }
        editor[id].setModel(model[id]);
        editor[id].updateOptions(
            {
                diffWordWrap: "on",
                wordWrap: "on"
            }
        );
    });
}
