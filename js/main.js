$(document).ready(function () {

    window.frequenciesTable = $('#frequenciesTable').DataTable({
        "oLanguage": {
            "sSearch": "Search"
        },
        responsive: {
            details: {
                type: 'column',
                target: 1
            }
        },
        keys: {
            keys: [38, 40]
        },
        ajax: 'database/full-frequencies.json',
        "columnDefs": [
            {
                "targets": 0,
                "render": function (data, type, row) {
                    return `<center><i class="bi bi-star" title="Add favourite" style="cursor: pointer;" data-name="${encodeURIComponent(row["name"])}"></i></center>`;
                }
            }
        ],
        columns: [
            { data: 'fav', orderDataType: `dom-class` },
            { data: 'name' },
            { data: 'frequency' },
            { data: 'author' }
        ],
        "initComplete": function (settings, json) {
            bindFavouriteItems();
        }
    });

    $('#frequenciesTable').on('key-focus.dt', function (e, datatable, cell) {

        if (cell.index().column == 0) {
            return;
        }

        window.frequenciesTable.$('tr.selected').removeClass('selected');
        $(window.frequenciesTable.row(cell.index().row).node()).addClass('selected');

        var data = window.frequenciesTable.row(cell.index().row).data();
        play(data["frequency"], data["name"]);
    });

    $('#frequenciesTable tbody').on('click', 'tr', function (evt) {

        let el = $(evt.target);

        if (el.is("i")) {
            if (el.hasClass("bi-star")) {
                el.removeClass("bi-star").addClass('bi-star-fill gold');
                el.attr("title", "Remove favourite");
                saveFavourite(el.data('name'));
            }
            else {
                el.removeClass("bi-star-fill gold").addClass('bi-star');
                el.attr("title", "Add favourite");
                deleteFavourite(el.data('name'));
            }
            return;
        }

        window.frequenciesTable.$('tr.selected').removeClass('selected');
        $(this).addClass('selected');

        var data = window.frequenciesTable.row(this).data();
        play(data["frequency"], data["name"]);

    });

    $.fn.dataTable.ext.order['dom-class'] = function (settings, col) {
        return this.api().column(col, { order: 'index' }).nodes().map(function (td, i) {
            return $('i', td).hasClass('bi-star-fill') ? '1' : '0';
        });
    }
});

function removeSelected() {
    if (window.frequenciesTable) {
        window.frequenciesTable.$('tr.selected').removeClass('selected');
    }
}

function saveFavourite(dataName) {
    let json = getFavouriteItemsJSON();
    json.data.push({ "name": dataName });

    window.localStorage.setItem("frequencierFavouriteItems", JSON.stringify(json));
}

function deleteFavourite(data) {
    let json = getFavouriteItemsJSON();
    json["data"].splice(json["data"].findIndex(x => x.name == data), 1);

    window.localStorage.setItem("frequencierFavouriteItems", JSON.stringify(json));
}

function bindFavouriteItems() {
    let json = getFavouriteItemsJSON();

    if (json == undefined) {
        return { "data": [] };
    }

    if (window.frequenciesTable) {
        window.frequenciesTable.rows().every(function (rowIdx, tableLoop, rowLoop) {
            let index = json["data"].findIndex(x => x.name == encodeURIComponent(this.data().name));
            if (index > -1) {
                var el = $(this.node()).find('td:first-child i');
                el.removeClass("bi-star").addClass('bi-star-fill gold');
                el.attr("title", "Remove favourite");
            }
        });
    }

    window.frequenciesTable.order([0, 'desc']).draw();
}

function getFavouriteItemsJSON() {
    let item = window.localStorage.getItem("frequencierFavouriteItems");

    if (item == undefined) {
        return { "data": [] };
    }

    return JSON.parse(item);
}