
import {html, render} from './vendor/lit-html/lit-html.js'

let menu_button = (label) =>
    html`<button type="button">${label}</button>`

let main_header = () => html`
    <head>
    <h1>PixiP</h1>
    <div>
        <span>Menu</span>
        <ul>
            <li>
                ${menu_button("New Session")}
            </li>
            <li>
                ${menu_button("Archive Old Sessions")}
            </li>
        </ul>
    </div>
    </head>
    `

let main_footer = () => html`
    <footer>
foo
    </footer>
`

let make_page = (header_res, footer_res) => 
    html`${header_res} ${footer_res}`


function main() {
    let lit_root = document.querySelector("#lit-root")
    console.log(lit_root)
    let header = main_header()
    let footer = main_footer()
    render(make_page(header, footer), lit_root)
    console.log("this is the thing")
}
main()
